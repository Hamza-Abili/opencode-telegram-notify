/**
 * opencode-telegram-notify — Telegram poller.
 *
 * Exactly one activation per bot token on the host (guaranteed by the poller
 * lock, which lives in a directory namespaced by a hash of the token) long-polls
 * getUpdates and routes:
 *   - inline button presses → permission decisions (tap-only, never auto);
 *   - chat commands (/start /help /status /setup /stop).
 *
 * Only the bound chat is served; unknown chats are ignored. Messages that are
 * not commands are ignored silently (this is a notifier, not a general bot).
 *
 * State persistence: the last processed update_id and the /stop silence flag
 * are stored in poller.offset.json next to the poller lock. Both survive
 * process restarts and, because the directory is shared per token, propagate
 * to the other activations of the same bot (standby instances mirror the
 * silence flag). A process-level dedupe set (Symbol.for) additionally guards
 * against redelivery within the same process lifetime.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext, FormChoice, PendingForm } from "./context.ts";
import { isSettledError, logReplyError, replyPermission, replyQuestion } from "./context.ts";
import { escapeHtml, truncateHtml } from "./format.ts";
import { decisionLabel, t } from "./i18n/index.ts";
import { openPollerLock } from "./lock.ts";
import type { TelegramUpdate } from "./telegram.ts";
import { TelegramError } from "./telegram.ts";
import type { PermissionDecision } from "./types.ts";

export interface PollerOptions {
  /**
   * Directory for the cross-process lock and state file. Default:
   * `<OS cache dir>/opencode-telegram-notify/<token namespace>`. An explicit
   * value is used as-is, so it must be absolute and shared on purpose
   * (`loadConfig` enforces the absolute path for plugin users).
   */
  lockDir?: string;
  /** How many seconds to wait on getUpdates long polling. */
  longPollSeconds?: number;
  /** Back-off while another instance owns the lock (ms). */
  acquireDelayMs?: number;
  /** Back-off after a 409 / other failure (ms). */
  standstillMs?: number;
  failureDelayMs?: number;
  /** Pause between empty long-poll cycles (ms). */
  pollIntervalMs?: number;
  /** Called when this activation gains/loses poller ownership. */
  onInteractiveChange?: (interactive: boolean) => void;
}

const POLL_ACQUIRE_DELAY_MS = 15_000;
const STANDSTILL_MS = 45_000;
const FAILURE_DELAY_MS = 5_000;
/** Offset + silence state; one file, written atomically, per bot token. */
const STATE_FILE = "poller.offset.json";
const SEEN_MAX = 2000;

/** Stable per-token directory suffix: two bots on one host never share state. */
export function tokenNamespace(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Process-level seen-update registry, keyed by `<token namespace>:<update_id>`.
 * `update_id` is per bot, so the namespace keeps two tokens in one process
 * from skipping each other's updates. Survives plugin reloads.
 */
const SEEN_SYMBOL = Symbol.for("opencode-telegram-notify/seen-updates");
function seenSet(): Set<string> {
  const store = globalThis as unknown as Record<symbol, Set<string>>;
  let set = store[SEEN_SYMBOL];
  if (!set) {
    set = new Set<string>();
    store[SEEN_SYMBOL] = set;
  }
  return set;
}
const seenUpdates = seenSet();

/** @internal clear the process-level dedupe set (test hook). */
export function resetProcessUpdateDedupe(): void {
  seenUpdates.clear();
}

function offsetFilePath(lockDir: string): string {
  return path.join(lockDir, STATE_FILE);
}

interface PollerState {
  offset: number;
  /** Persisted /stop silence, shared by every activation of this bot token. */
  silenced: boolean;
}

function readState(lockDir: string): PollerState {
  try {
    const raw = fs.readFileSync(offsetFilePath(lockDir), "utf8");
    const parsed = JSON.parse(raw);
    return {
      offset:
        typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
          ? parsed.offset
          : 0,
      silenced: parsed.silenced === true,
    };
  } catch {
    // missing or malformed → start fresh
  }
  return { offset: 0, silenced: false };
}

function writeState(lockDir: string, state: PollerState): void {
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    const tmp = `${offsetFilePath(lockDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, offsetFilePath(lockDir));
  } catch {
    // best effort; next successful write will catch up
  }
}

function defaultLockDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "opencode-telegram-notify");
}

/**
 * One-time advisory: on a group chat without `allowedUserIds` any member can
 * tap permission buttons or run bot commands. Logged, never enforced, so an
 * explicit empty list keeps working (private chats are the common case).
 */
function warnOpenGroupChat(ctx: AppContext): void {
  if (ctx.config.telegram.allowedUserIds.length > 0) return;
  const chat = ctx.config.telegram.chatId.trim();
  if (/^-\d+$/.test(chat)) {
    ctx.log(
      `group chat ${chat} has no allowedUserIds: any member can tap buttons or run bot commands — set options.telegram.allowedUserIds to restrict`
    );
  }
}

function sameChat(ctx: AppContext, chatId: number | undefined): boolean {
  return chatId !== undefined && String(chatId) === String(ctx.config.telegram.chatId);
}

function userAllowed(ctx: AppContext, fromId: number | undefined): boolean {
  if (!fromId) return false;
  const allowed = ctx.config.telegram.allowedUserIds;
  if (allowed.length === 0) return true;
  return allowed.includes(String(fromId));
}

const DECISIONS: Record<string, PermissionDecision> = {
  allow: "once",
  always: "always",
  reject: "reject",
};

function setupSnippet(ctx: AppContext): string {
  const lines = [
    "{",
    '  "plugins": [',
    "    {",
    '      "package": "@hamzaabili/opencode-telegram-notify",',
    '      "options": {',
    '        "telegram": {',
    '          "botToken": "${TELEGRAM_BOT_TOKEN}",',
    '          "chatId": "${TELEGRAM_CHAT_ID}"',
    "        },",
    `        "language": "${ctx.config.language}"`,
    "      }",
    "    }",
    "  ]",
    "}",
  ];
  return lines.join("\n");
}

async function handleCommand(ctx: AppContext, command: string, chatId: number): Promise<void> {
  const raw = command.split(/\s+/, 1)[0];
  const cmd = (raw ?? "").replace(/@\S+$/, "").toLowerCase();
  try {
    switch (cmd) {
      case "/start": {
        ctx.silenced = false;
        await ctx.telegram.sendMessage(t(ctx.config.language, "start", { chatId: String(chatId) }));
        return;
      }
      case "/stop": {
        ctx.silenced = true;
        await ctx.telegram.sendMessage(t(ctx.config.language, "shuttingDone"), { silent: true });
        return;
      }
      case "/status": {
        const events = [
          ctx.config.events.permission ? "permission" : null,
          ctx.config.events.question ? "question" : null,
          ctx.config.events.idle ? "idle" : null,
          ctx.config.events.error ? "error" : null,
          ctx.config.events.usage ? "usage" : null,
        ]
          .filter(Boolean)
          .join(", ");
        const lang = ctx.config.language;
        const ignore = [
          ctx.config.ignore.titles.length > 0
            ? `${t(lang, "ignoreTitles")}: ${ctx.config.ignore.titles.join(", ")}`
            : null,
          ctx.config.ignore.agents.length > 0
            ? `${t(lang, "ignoreAgents")}: ${ctx.config.ignore.agents.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        const text = [
          t(lang, "statusOnline"),
          `${t(lang, "project")}: <b>${escapeHtml(ctx.project)}</b>`,
          ctx.silenced ? t(lang, "statusSilenced") : t(lang, "statusActive"),
          ctx.interactive ? t(lang, "statusInteractive") : t(lang, "statusStandby"),
          `${t(lang, "eventsLabel")}: ${events}`,
          `${t(lang, "ignoreLabel")}: ${escapeHtml(ignore || t(lang, "ignoreNone"))}`,
        ].join("\n");
        await ctx.telegram.sendMessage(truncateHtml(text, ctx.config.maxMessageChars));
        return;
      }
      case "/setup": {
        const snippet = `<pre>${escapeHtml(setupSnippet(ctx))}</pre>`;
        await ctx.telegram.sendMessage(
          [
            "<b>opencode.jsonc</b>",
            snippet,
            `${t(ctx.config.language, "envVars")} <code>TELEGRAM_BOT_TOKEN</code> · <code>TELEGRAM_CHAT_ID=${escapeHtml(ctx.config.telegram.chatId)}</code>`,
          ].join("\n")
        );
        return;
      }
      default: {
        await ctx.telegram.sendMessage(t(ctx.config.language, "help"));
        return;
      }
    }
  } catch (error) {
    ctx.logError(`command ${cmd} failed: ${String(error)}`);
  }
}

async function handleMessage(ctx: AppContext, update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return;
  if (!sameChat(ctx, msg.chat?.id)) return;
  if (!userAllowed(ctx, msg.from?.id)) return;
  const text = msg.text.trim();
  if (!text.startsWith("/")) return; // notifier bot: plain text ignored
  await handleCommand(ctx, text, msg.chat.id);
}

async function handleCallback(ctx: AppContext, update: TelegramUpdate): Promise<void> {
  const cb = update.callback_query;
  if (!cb?.message) return;
  if (!sameChat(ctx, cb.message.chat?.id)) return;
  if (!userAllowed(ctx, cb.from?.id)) return;

  const messageId = cb.message.message_id;
  const entry = messageId !== undefined ? ctx.pending.get(messageId) : undefined;

  // Question buttons: "q:<index>" answers the form's single field, "qskip"
  // rejects the question. Same ownership/chat gates as permission taps.
  if (cb.data && (cb.data === "qskip" || cb.data.startsWith("q:"))) {
    const formEntry = messageId !== undefined ? ctx.pendingForms.get(messageId) : undefined;
    if (!formEntry) {
      await staleCallbackAck(ctx, cb.id, messageId);
      return;
    }
    if (cb.data === "qskip") {
      await answerForm(ctx, messageId, formEntry, null, cb.id);
      return;
    }
    const choice = formEntry.options[Number(cb.data.slice(2))];
    if (choice === undefined) {
      await staleCallbackAck(ctx, cb.id, messageId);
      return;
    }
    await answerForm(ctx, messageId, formEntry, choice, cb.id);
    return;
  }

  if (!entry || !cb.data) {
    // Buttons from a previous instance / already settled.
    await staleCallbackAck(ctx, cb.id, messageId);
    return;
  }

  const decision = DECISIONS[cb.data];
  if (!decision) {
    await reportOutcome(ctx, undefined, cb.id, t(ctx.config.language, "expiredOrStale"));
    return;
  }

  const lang = ctx.config.language;
  try {
    await replyPermission(ctx, entry.sessionID, entry.requestID, decision);
    ctx.pending.delete(messageId);
    const text =
      decision === "reject"
        ? t(lang, "doneRejected")
        : t(lang, "doneAllowed", { decision: decisionLabel(lang, decision) });
    await reportOutcome(ctx, messageId, cb.id, text);
  } catch (error) {
    logReplyError(ctx, "permission reply", error);
    if (isSettledError(error)) {
      ctx.pending.delete(messageId);
      await reportOutcome(ctx, messageId, cb.id, t(lang, "answeredInTerminal"));
    } else {
      // Keep the pending entry and the message with its buttons: the user can
      // tap again after a transient network/server failure. Editing the body
      // here would remove the inline keyboard and the only interactive path.
      await reportOutcome(ctx, undefined, cb.id, t(lang, "replyFailedRetry"));
    }
  }
}

/** Acknowledge a callback whose target message/button is outdated or settled elsewhere. */
async function staleCallbackAck(
  ctx: AppContext,
  callbackId: string,
  messageId?: number
): Promise<void> {
  await reportOutcome(
    ctx,
    messageId,
    callbackId,
    t(ctx.config.language, "expiredOrStale"),
    "italic"
  );
}

/**
 * Show a tap outcome in both places: a toast on the button and the message
 * body (which also drops the now-useless keyboard). Feedback is best-effort:
 * a failed edit/ack never turns a successful reply into an error path.
 */
async function reportOutcome(
  ctx: AppContext,
  messageId: number | undefined,
  callbackId: string,
  text: string,
  style: "bold" | "italic" = "bold"
): Promise<void> {
  const escaped = escapeHtml(text);
  const html = style === "italic" ? `<i>${escaped}</i>` : `<b>${escaped}</b>`;
  const results = await Promise.allSettled([
    ctx.telegram.answerCallbackQuery(callbackId, text),
    ...(messageId === undefined ? [] : [ctx.telegram.editMessageText(messageId, html)]),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      ctx.logError(`tap feedback failed: ${String(result.reason)}`);
    }
  }
}

/**
 * Settle a pending question from an explicit tap: reply through the active
 * form/question surface ({@link replyQuestion}), close the message, and fall
 * back to the "answered elsewhere" wording when the request was settled in the
 * meantime. Tap-only: the initial message is never a source of answers.
 */
async function answerForm(
  ctx: AppContext,
  messageId: number,
  formEntry: PendingForm,
  choice: FormChoice | null,
  callbackId: string
): Promise<void> {
  const lang = ctx.config.language;
  try {
    await replyQuestion(
      ctx,
      formEntry.formID,
      formEntry.sessionID,
      formEntry.fieldKey,
      formEntry.fieldType,
      choice
    );
    ctx.pendingForms.delete(messageId);
    const text = choice === null ? t(lang, "doneSkipped") : t(lang, "doneAnswered");
    await reportOutcome(ctx, messageId, callbackId, text);
  } catch (error) {
    logReplyError(ctx, "question reply", error);
    if (isSettledError(error)) {
      ctx.pendingForms.delete(messageId);
      await reportOutcome(ctx, messageId, callbackId, t(lang, "answeredInTerminal"));
    } else {
      // Keep the pending entry and the message with its buttons so the tap can
      // be retried; an edit would strip the inline keyboard.
      await reportOutcome(ctx, undefined, callbackId, t(lang, "replyFailedRetry"));
    }
  }
}

/** Route one Telegram update (commands and callbacks). Exported for tests. */
export async function dispatch(ctx: AppContext, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(ctx, update);
    return;
  }
  if (update.message) {
    await handleMessage(ctx, update);
    return;
  }
}

/**
 * Start the polling loop. Returns a dispose that stops the loop at the next
 * cycle boundary; the lock is released only after the in-flight update has
 * been dispatched and persisted. If a host SDK call never settles, the lock
 * is kept (and heartbeated) rather than risking a split-brain standby; the
 * process then needs a restart.
 */
export function startPoller(ctx: AppContext, options: PollerOptions = {}): () => void {
  // An explicit lockDir is used as-is (tests, power users); the default is
  // namespaced per bot token so two bots on one host can never share a lock
  // or cross-pollute each other's update offset.
  const namespace = tokenNamespace(ctx.config.telegram.botToken);
  const lockDir = options.lockDir ?? path.join(defaultLockDir(), namespace);
  const longPoll = options.longPollSeconds ?? 20;
  const acquireDelay = options.acquireDelayMs ?? POLL_ACQUIRE_DELAY_MS;
  const standstill = options.standstillMs ?? STANDSTILL_MS;
  const failureDelay = options.failureDelayMs ?? FAILURE_DELAY_MS;
  const pollInterval = options.pollIntervalMs ?? 250;
  const lock = openPollerLock(lockDir, { log: ctx.log });

  let running = true;
  let owned = false;
  let commandsAttempted = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();

  const initial = readState(lockDir);
  let offset = initial.offset;
  /**
   * Persist offset + silence in one atomic write. Called after every handled
   * update (and every dedupe hit) so a dispose mid-batch, a crash or a lost
   * write can never make Telegram redeliver an update forever.
   */
  const commit = (next: number): void => {
    offset = next;
    writeState(lockDir, { offset, silenced: ctx.silenced });
  };
  if (initial.silenced) {
    ctx.silenced = true;
    ctx.log("resuming silenced state persisted by /stop");
  }
  warnOpenGroupChat(ctx);

  function setInteractive(value: boolean): void {
    if (owned === value) return;
    owned = value;
    if (!value) commandsAttempted = false; // retry the menu after regaining ownership
    ctx.interactive = value;
    try {
      options.onInteractiveChange?.(value);
    } catch (error) {
      ctx.logError(`interactive callback failed: ${String(error)}`);
    }
  }

  const loopDone = (async () => {
    while (running) {
      if (!lock.tryAcquire()) {
        setInteractive(false);
        // A live owner persists /stop; standby instances mirror it so silence
        // reaches every project of this bot token, not just the poller.
        const shared = readState(lockDir);
        if (shared.silenced !== ctx.silenced) ctx.silenced = shared.silenced;
        await sleep(acquireDelay);
        continue;
      }
      // Another instance may have polled while we waited: never replay its
      // updates, and honor the silence it persisted. Read-only: a standby that
      // writes here could clobber a live owner's state.
      if (!owned) {
        const shared = readState(lockDir);
        offset = Math.max(offset, shared.offset);
        ctx.silenced = shared.silenced;
      }
      setInteractive(true);
      if (!heartbeat) {
        heartbeat = setInterval(lock.heartbeat, 10_000);
        // v1 hosts have no plugin dispose chain: never keep a server process
        // alive just because of a poller heartbeat.
        (heartbeat as unknown as { unref?: () => void }).unref?.();
      }
      if (!commandsAttempted) {
        // The menu is cosmetic: attempt it once per ownership acquisition
        // instead of retrying every poll cycle (which would hammer the API on
        // failure). A lost/regained lock resets the flag, so a boot-time
        // network failure still recovers.
        commandsAttempted = true;
        try {
          const lang = ctx.config.language;
          await ctx.telegram.setMyCommands([
            { command: "start", description: t(lang, "commandStart") },
            { command: "status", description: t(lang, "commandStatus") },
            { command: "setup", description: t(lang, "commandSetup") },
            { command: "stop", description: t(lang, "commandStop") },
            { command: "help", description: t(lang, "commandHelp") },
          ]);
        } catch (error) {
          ctx.logError(`setMyCommands failed: ${String(error)}`);
        }
      }
      try {
        const updates = await ctx.telegram.getUpdates(offset, longPoll, controller.signal);
        for (const update of updates) {
          if (!running) break;
          const seenKey = `${namespace}:${update.update_id}`;
          if (seenUpdates.has(seenKey)) {
            // Already dispatched in this process lifetime (the state write may
            // have been lost to a crash): confirm it, or Telegram returns it
            // on every poll and the offset never moves again.
            commit(update.update_id + 1);
            continue;
          }
          if (seenUpdates.size >= SEEN_MAX) {
            const oldest = seenUpdates.values().next().value;
            if (oldest !== undefined) seenUpdates.delete(oldest);
          }
          await dispatch(ctx, update);
          // Persist per update, without a `running` guard: the update was
          // handled, so a dispose during the batch must not replay it (or
          // discard the /stop it just recorded).
          commit(update.update_id + 1);
          seenUpdates.add(seenKey);
        }
      } catch (error) {
        if (!running) break; // aborted by dispose
        if (error instanceof TelegramError && error.code === 409) {
          // Another process on the host is polling; stand by until it stops.
          lock.release();
          setInteractive(false);
          await sleep(standstill);
          continue;
        }
        // Non-409 error: do not advance offset, retry with same offset next cycle
        ctx.logError(`getUpdates failed: ${String(error)}`);
        await sleep(failureDelay);
      }
      // Short pause between long-poll cycles: keeps the loop off the CPU when
      // updates come back empty and (in tests or offline mode) prevents a
      // microtask-only spin from starving timers.
      if (running) await sleep(pollInterval);
    }
  })().catch((error) => {
    ctx.logError(`poller crashed: ${String(error)}`);
  });

  return () => {
    running = false;
    controller.abort();
    setInteractive(false);
    // Keep the heartbeat and lock until the loop drains: releasing first lets
    // a standby acquire the lock, read stale state and overwrite the /stop
    // silence or offset that the in-flight dispatch is about to commit.
    void loopDone.finally(() => {
      if (heartbeat) clearInterval(heartbeat);
      lock.release();
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
