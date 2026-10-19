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

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  HELP,
  PROJECT,
  SHUTTING_DONE,
  START,
  STATUS_ONLINE,
  EXPIRED_OR_STALE,
  DONE_ALLOWED,
  DONE_REJECTED,
  ANSWERED_IN_TERMINAL,
  decisionLabel,
  tr,
} from "./i18n.ts";
import { openPollerLock } from "./lock.ts";
import type { AppContext } from "./context.ts";
import { replyPermission } from "./context.ts";
import { escapeHtml } from "./format.ts";
import type { TelegramUpdate } from "./telegram.ts";
import { TelegramError } from "./telegram.ts";
import type { PermissionDecision } from "./types.ts";

export interface PollerOptions {
  /** Directory for the cross-process poller lock. Default: OS cache dir. */
  lockDir?: string;
  /** How many seconds to wait on getUpdates long polling. */
  longPollSeconds?: number;
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
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
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
    const tmp = offsetFilePath(lockDir) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ offset }));
    fs.renameSync(tmp, offsetFilePath(lockDir));
  } catch (error) {
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
  const [raw, ..._rest] = command.split(/\s+/);
  const cmd = (raw ?? "").replace(/@\S+$/, "").toLowerCase();
  try {
    switch (cmd) {
      case "/start": {
        ctx.silenced = false;
        await ctx.telegram.sendMessage(
          tr(ctx.config.language, START, { chatId: String(chatId) })
        );
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
        const text = [
          STATUS_ONLINE[ctx.config.language],
          `${PROJECT[ctx.config.language]}: <b>${escapeHtml(ctx.project)}</b>`,
          ctx.silenced ? "🔕 silenced (use /start)" : "🔔 notifications active",
          `events: ${events}`,
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
  if (!cb || !cb.message) return;
  if (!sameChat(ctx, cb.message.chat?.id)) return;
  if (!userAllowed(ctx, cb.from?.id)) return;

  const messageId = cb.message.message_id;
  const entry = messageId !== undefined ? ctx.pending.get(messageId) : undefined;

  if (!entry || !cb.data) {
    // Buttons from a previous instance / already settled.
    try {
      await ctx.telegram.answerCallbackQuery(cb.id, EXPIRED_OR_STALE[ctx.config.language]);
      if (messageId !== undefined) {
        await ctx.telegram
          .editMessageText(messageId, `<i>${escapeHtml(EXPIRED_OR_STALE[ctx.config.language])}</i>`)
          .catch(() => undefined);
      }
    } catch {
      // ignore
    }
    return;
  }

  const decision = DECISIONS[cb.data];
  if (!decision) {
    try {
      await ctx.telegram.answerCallbackQuery(cb.id, EXPIRED_OR_STALE[ctx.config.language]);
    } catch {
      // ignore
    }
    return;
  }

  ctx.pending.delete(messageId);
  try {
    await replyPermission(ctx, entry.sessionID, entry.requestID, decision);
    const text =
      decision === "reject"
        ? DONE_REJECTED[ctx.config.language]
        : tr(ctx.config.language, DONE_ALLOWED, {
            decision: decisionLabel(ctx.config.language, decision),
          });
    try {
      await ctx.telegram.editMessageText(messageId, `<b>${escapeHtml(text)}</b>`);
      await ctx.telegram.answerCallbackQuery(cb.id, text);
    } catch (editError) {
      ctx.logError(`edit/ack after reply failed: ${String(editError)}`);
    }
  } catch (error) {
    // The most common "failure" is that the request was settled elsewhere.
    try {
      await ctx.telegram.answerCallbackQuery(cb.id, ANSWERED_IN_TERMINAL[ctx.config.language]);
      await ctx.telegram
        .editMessageText(messageId, `<b>${escapeHtml(ANSWERED_IN_TERMINAL[ctx.config.language])}</b>`)
        .catch(() => undefined);
    } catch {
      // ignore
    }
    ctx.logError(`permission reply failed: ${String(error)}`);
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
  const lock = openPollerLock(lockDir, { log: ctx.log });

  let running = true;
  let commandsRegistered = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let offset = readOffset(lockDir);

  const loopDone = (async () => {
    while (running) {
      if (!lock.tryAcquire()) {
        await sleep(POLL_ACQUIRE_DELAY_MS);
        continue;
      }
      if (running && !heartbeat) {
        heartbeat = setInterval(lock.heartbeat, 10_000);
        // v1 hosts have no plugin dispose chain: never keep a server process
        // alive just because of a poller heartbeat.
        (heartbeat as unknown as { unref?: () => void }).unref?.();
      }
      if (!commandsRegistered) {
        try {
          await ctx.telegram.setMyCommands([
            { command: "start", description: "Connect + chat id" },
            { command: "status", description: "Plugin status" },
            { command: "setup", description: "Copy-paste config" },
            { command: "stop", description: "Silence until /start" },
            { command: "help", description: "What this bot does" },
          ]);
          commandsRegistered = true;
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
          await sleep(STANDSTILL_MS);
          continue;
        }
        // Non-409 error: do not advance offset, retry with same offset next cycle
        ctx.logError(`getUpdates failed: ${String(error)}`);
        await sleep(FAILURE_DELAY_MS);
      }
      // Short pause between long-poll cycles: keeps the loop off the CPU when
      // updates come back empty and (in tests or offline mode) prevents a
      // microtask-only spin from starving timers.
      if (running) await sleep(250);
    }
  })().catch((error) => {
    ctx.logError(`poller crashed: ${String(error)}`);
  });

  return () => {
    running = false;
    if (heartbeat) clearInterval(heartbeat);
    lock.release();
    void loopDone;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
