/**
 * opencode-telegram-notify — runtime context shared by the event router
 * and the Telegram poller.
 */

import fs from "node:fs";
import type { AppConfig } from "./config.ts";
import { TelegramClient, TelegramError, redactToken } from "./telegram.ts";
import type { PermissionDecision, V2Client, V2PermissionRequest } from "./types.ts";

export interface PendingPermission {
  sessionID: string;
  requestID: string;
  action: string;
}

/** A pending single-select question rendered as tap buttons. */
export interface PendingForm {
  formID: string;
  sessionID: string;
  options: string[];
}

export interface AppContext {
  config: AppConfig;
  client: V2Client;
  telegram: TelegramClient;
  /** Resolved plugin root (equals client.location.directory). */
  root: string;
  /** Basename of the root project directory, for headers. */
  project: string;
  /** Cache of session titles seen on the event stream. */
  sessionTitles: Map<string, string>;
  /** sessionID -> directory attribution index (for events without location). */
  sessionDirs: Map<string, string>;
  /** Telegram message id -> pending permission (callback routing). */
  pending: Map<number, PendingPermission>;
  /** Telegram message id -> pending single-select question (callback routing). */
  pendingForms: Map<number, PendingForm>;
  /** permission request id -> telegram message id (close notifications). */
  permMsgs: Map<string, number>;
  /** form id -> telegram message id, to close question messages. */
  formMsgs: Map<string, number>;
  /** True after /stop in the bound chat; re-enabled by /start. */
  silenced: boolean;
  log(message: string): void;
  logError(message: string): void;
}

/** Append-only, redacting logger. Line-oriented; safe to file or console. */
export function createLogger(
  token: string,
  logFile?: string
): { log: (m: string) => void; logError: (m: string) => void } {
  let write: (line: string) => void = (line) => console.log(line);
  if (logFile) {
    write = (line) => {
      try {
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // never let logging break the plugin
      }
    };
  }
  const safe = (m: string) => redactToken(String(m), token);
  return {
    log: (m) => write(`[opencode-telegram-notify] ${safe(m)}`),
    logError: (m) => write(`[opencode-telegram-notify][error] ${safe(m)}`),
  };
}

/**
 * Reply to a pending permission using the v2 client. The documented surface
 * uses `decision`; early builds accepted `reply` — both are attempted and
 * the fallback is logged (not silent).
 */
export async function replyPermission(
  ctx: AppContext,
  sessionID: string,
  requestID: string,
  decision: PermissionDecision,
  message?: string
): Promise<void> {
  const perm = ctx.client.permission;
  if (!perm) throw new Error("permission client not available");
  try {
    await perm.reply({ sessionID, requestID, decision, message });
    return;
  } catch (decisionError) {
    try {
      await perm.reply({ sessionID, requestID, reply: decision, message } as never);
      ctx.log("permission.reply fallback via `reply` field succeeded");
      return;
    } catch (replyError) {
      throw decisionError instanceof Error ? decisionError : replyError;
    }
  }
}

/** List pending permission requests for a session (diagnostics). */
export async function listPermissions(
  ctx: AppContext,
  sessionID: string
): Promise<V2PermissionRequest[]> {
  const perm = ctx.client.permission;
  if (!perm) return [];
  try {
    return await perm.list({ sessionID });
  } catch (error) {
    ctx.logError(`permission.list failed: ${String(error)}`);
    return [];
  }
}

/** Loose typing for the session-scoped question fallback of the v2 SDK. */
interface LooseQuestion {
  reply?: (input: {
    requestID: string;
    answers?: string[][];
    sessionID?: string;
    questionV2Reply?: { answers: string[][] };
  }) => Promise<unknown>;
  reject?: (input: { requestID: string }) => Promise<unknown>;
  list?: (input: { directory: string }) => Promise<unknown>;
}

function questionSurface(ctx: AppContext, scoped?: boolean): LooseQuestion | undefined {
  if (scoped) {
    const session = (ctx.client as unknown as { session?: { question?: LooseQuestion } }).session;
    return session?.question;
  }
  return ctx.client.question;
}

/**
 * Answer a pending question (form) from a Telegram tap. Mirrors the
 * permission dual-surface strategy: the global `question.reply` ships first,
 * the session-scoped `session.question.reply` is the fallback. `null` labels
 * means "skip" and uses `question.reject`; a missing surface throws.
 */
export async function replyQuestion(
  ctx: AppContext,
  formID: string,
  sessionID: string,
  labels: string[] | null
): Promise<void> {
  if (labels === null) {
    const reject = questionSurface(ctx)?.reject;
    if (!reject) throw new Error("question reject surface not available");
    await reject({ requestID: formID });
    return;
  }
  const answer = labels.length === 0 ? undefined : [labels];
  const surface = questionSurface(ctx);
  if (surface?.reply) {
    await surface.reply({ requestID: formID, answers: answer ?? [] });
    return;
  }
  const scoped = questionSurface(ctx, true);
  if (scoped?.reply) {
    await scoped.reply({ requestID: formID, sessionID, questionV2Reply: { answers: answer ?? [] } });
    ctx.log("question reply via session-scoped surface succeeded");
    return;
  }
  throw new Error("question reply surface not available");
}

/** List pending questions for the plugin root, or an empty array when unavailable. */
export async function listPendingQuestions(ctx: AppContext): Promise<unknown[]> {
  const list = questionSurface(ctx)?.list;
  if (!list) return [];
  try {
    const result = await list({ directory: ctx.root });
    if (Array.isArray(result)) return result;
    if (result && typeof result === "object" && Array.isArray((result as { items?: unknown[] }).items)) {
      return (result as { items: unknown[] }).items;
    }
    return [];
  } catch (error) {
    ctx.logError(`question.list failed: ${String(error)}`);
    return [];
  }
}

export { TelegramError };
