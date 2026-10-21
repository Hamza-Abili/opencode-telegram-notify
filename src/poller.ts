/**
 * opencode-telegram-notify — Telegram poller.
 *
 * Exactly one activation on the host (guaranteed by the poller lock) long-polls
 * getUpdates and routes:
 *   - inline button presses → permission decisions (tap-only, never auto);
 *   - chat commands (/start /help /status /setup /stop).
 *
 * Only the bound chat is served; unknown chats are ignored. Messages that are
 * not commands are ignored silently (this is a notifier, not a general bot).
 *
 * Offset persistence: the last processed update_id is stored in poller.offset.json
 * alongside the poller lock file. This survives process restarts and prevents
 * reprocessing old updates. A process-level dedupe set (Symbol.for) provides
 * additional protection against redelivery within the same process lifetime.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext, FormChoice, PendingForm } from "./context.ts";
import { isSettledError, logReplyError, replyPermission, replyQuestion } from "./context.ts";
import { escapeHtml } from "./format.ts";
import {
  ANSWERED_IN_TERMINAL,
  COMMAND_HELP,
  COMMAND_SETUP,
  COMMAND_START,
  COMMAND_STATUS,
  COMMAND_STOP,
  DONE_ALLOWED,
  DONE_ANSWERED,
  DONE_REJECTED,
  DONE_SKIPPED,
  decisionLabel,
  EVENTS_LABEL,
  EXPIRED_OR_STALE,
  HELP,
  PROJECT,
  REPLY_FAILED_RETRY,
  SHUTTING_DONE,
  START,
  STATUS_ACTIVE,
  STATUS_INTERACTIVE,
  STATUS_ONLINE,
  STATUS_SILENCED,
  STATUS_STANDBY,
  tr,
} from "./i18n.ts";
import { openPollerLock } from "./lock.ts";
import type { TelegramUpdate } from "./telegram.ts";
import { TelegramError } from "./telegram.ts";
import type { PermissionDecision } from "./types.ts";

export interface PollerOptions {
  /** Directory for the cross-process poller lock. Default: OS cache dir. */
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
const OFFSET_FILE = "poller.offset.json";
const SEEN_MAX = 2000;

/** Process-level seen-update registry; survives plugin reloads in one process. */
const SEEN_SYMBOL = Symbol.for("opencode-telegram-notify/seen-updates");
function seenSet(): Set<number> {
  const store = globalThis as unknown as Record<symbol, Set<number>>;
  let set = store[SEEN_SYMBOL];
  if (!set) {
    set = new Set<number>();
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
  return path.join(lockDir, OFFSET_FILE);
}

function readOffset(lockDir: string): number {
  try {
    const raw = fs.readFileSync(offsetFilePath(lockDir), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
  } catch {
    // missing or malformed → start from 0
  }
  return 0;
}

function writeOffset(lockDir: string, offset: number): void {
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    const tmp = `${offsetFilePath(lockDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ offset }));
    fs.renameSync(tmp, offsetFilePath(lockDir));
  } catch {
    // best effort; next successful write will catch up
  }
}

function defaultLockDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "opencode-telegram-notify");
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
        await ctx.telegram.sendMessage(tr(ctx.config.language, START, { chatId: String(chatId) }));
        return;
      }
      case "/stop": {
        ctx.silenced = true;
        await ctx.telegram.sendMessage(SHUTTING_DONE[ctx.config.language], { silent: true });
        return;
      }
      case "/status": {
        const events = [
          ctx.config.events.permission ? "permission" : null,
          ctx.config.events.question ? "question" : null,
          ctx.config.events.idle ? "idle" : null,
          ctx.config.events.error ? "error" : null,
        ]
          .filter(Boolean)
          .join(", ");
        const lang = ctx.config.language;
        const text = [
          STATUS_ONLINE[lang],
          `${PROJECT[lang]}: <b>${escapeHtml(ctx.project)}</b>`,
          ctx.silenced ? STATUS_SILENCED[lang] : STATUS_ACTIVE[lang],
          ctx.interactive ? STATUS_INTERACTIVE[lang] : STATUS_STANDBY[lang],
          `${EVENTS_LABEL[lang]}: ${events}`,
        ].join("\n");
        await ctx.telegram.sendMessage(text);
        return;
      }
      case "/setup": {
        const snippet = `<pre>${escapeHtml(setupSnippet(ctx))}</pre>`;
        await ctx.telegram.sendMessage(
          [
            "<b>opencode.jsonc</b>",
            snippet,
            `Env vars: <code>TELEGRAM_BOT_TOKEN</code> · <code>TELEGRAM_CHAT_ID=${escapeHtml(ctx.config.telegram.chatId)}</code>`,
          ].join("\n")
        );
        return;
      }
      default: {
        await ctx.telegram.sendMessage(HELP[ctx.config.language]);
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
    await reportOutcome(ctx, undefined, cb.id, EXPIRED_OR_STALE[ctx.config.language]);
    return;
  }

  const lang = ctx.config.language;
  try {
    await replyPermission(ctx, entry.sessionID, entry.requestID, decision);
    ctx.pending.delete(messageId);
    const text =
      decision === "reject"
        ? DONE_REJECTED[lang]
        : tr(lang, DONE_ALLOWED, { decision: decisionLabel(lang, decision) });
    await reportOutcome(ctx, messageId, cb.id, text);
  } catch (error) {
    logReplyError(ctx, "permission reply", error);
    if (isSettledError(error)) {
      ctx.pending.delete(messageId);
      await reportOutcome(ctx, messageId, cb.id, ANSWERED_IN_TERMINAL[lang]);
    } else {
      // Keep the pending entry and the message with its buttons: the user can
      // tap again after a transient network/server failure. Editing the body
      // here would remove the inline keyboard and the only interactive path.
      await reportOutcome(ctx, undefined, cb.id, REPLY_FAILED_RETRY[lang]);
    }
  }
}

/** Acknowledge a callback whose target message/button is outdated or settled elsewhere. */
async function staleCallbackAck(
  ctx: AppContext,
  callbackId: string,
  messageId?: number
): Promise<void> {
  await reportOutcome(ctx, messageId, callbackId, EXPIRED_OR_STALE[ctx.config.language], "italic");
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
 * Settle a pending question from an explicit tap: reply through
 * question.reply ({@link replyQuestion}), close the message, and fall back to
 * the "answered elsewhere" wording when the request was settled in the
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
    await replyQuestion(ctx, formEntry.formID, formEntry.sessionID, formEntry.fieldKey, choice);
    ctx.pendingForms.delete(messageId);
    const text = choice === null ? DONE_SKIPPED[lang] : DONE_ANSWERED[lang];
    await reportOutcome(ctx, messageId, callbackId, text);
  } catch (error) {
    logReplyError(ctx, "question reply", error);
    if (isSettledError(error)) {
      ctx.pendingForms.delete(messageId);
      await reportOutcome(ctx, messageId, callbackId, ANSWERED_IN_TERMINAL[lang]);
    } else {
      // Keep the pending entry and the message with its buttons so the tap can
      // be retried; an edit would strip the inline keyboard.
      await reportOutcome(ctx, undefined, callbackId, REPLY_FAILED_RETRY[lang]);
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
 * cycle boundary and releases the cross-process lock.
 */
export function startPoller(ctx: AppContext, options: PollerOptions = {}): () => void {
  const lockDir = options.lockDir ?? defaultLockDir();
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
  let offset = readOffset(lockDir);

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
        await sleep(acquireDelay);
        continue;
      }
      // A standby instance may have advanced the shared offset while we were
      // waiting; never replay updates it already handled.
      offset = Math.max(offset, readOffset(lockDir));
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
            { command: "start", description: COMMAND_START[lang] },
            { command: "status", description: COMMAND_STATUS[lang] },
            { command: "setup", description: COMMAND_SETUP[lang] },
            { command: "stop", description: COMMAND_STOP[lang] },
            { command: "help", description: COMMAND_HELP[lang] },
          ]);
        } catch (error) {
          ctx.logError(`setMyCommands failed: ${String(error)}`);
        }
      }
      try {
        const updates = await ctx.telegram.getUpdates(offset, longPoll);
        for (const update of updates) {
          if (!running) break;
          // Dedupe: skip updates already seen in this process lifetime
          if (seenUpdates.has(update.update_id)) continue;
          if (seenUpdates.size >= SEEN_MAX) {
            const oldest = seenUpdates.values().next().value;
            if (oldest !== undefined) seenUpdates.delete(oldest);
          }
          await dispatch(ctx, update);
          // Only advance offset after successful dispatch; persist immediately
          offset = update.update_id + 1;
          seenUpdates.add(update.update_id);
          writeOffset(lockDir, offset);
        }
      } catch (error) {
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
    setInteractive(false);
    if (heartbeat) clearInterval(heartbeat);
    lock.release();
    void loopDone;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
