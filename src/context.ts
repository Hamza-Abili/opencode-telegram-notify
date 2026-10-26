/**
 * opencode-telegram-notify — runtime context shared by the event router
 * and the Telegram poller.
 */

import fs from "node:fs";
import type { AppConfig } from "./config.ts";
import { redactToken, type TelegramClient } from "./telegram.ts";
import type {
  FormAnswer,
  LooseQuestion,
  PermissionDecision,
  PermissionReplyField,
  TokenUsageInfo,
  V2Client,
} from "./types.ts";

export interface PendingPermission {
  sessionID: string;
  requestID: string;
  action: string;
}

/** One answer choice of a single-select question. */
export interface FormChoice {
  value: string;
  label: string;
}

/** A pending single-select question rendered as tap buttons. */
export interface PendingForm {
  formID: string;
  sessionID: string;
  fieldKey: string;
  options: FormChoice[];
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
  /**
   * Whether this activation currently owns the Telegram poller. Only the
   * owner can receive button callbacks, so other instances send plain
   * notifications instead of dead buttons.
   */
  interactive: boolean;
  /** Cached permission reply shape that this host accepted. */
  permissionReplyField?: PermissionReplyField;
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
 * Reply to a pending permission using the v2 client.
 *
 * opencode 2.0.32 uses `decision`; early v2 builds and the v1 adapter use
 * `reply`. The first successful shape is cached, so the fallback is probed at
 * most once per activation instead of on every tap.
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

  const preferred = ctx.permissionReplyField ?? ctx.client.permissionReplyField;
  const order: PermissionReplyField[] =
    preferred === "reply" ? ["reply", "decision"] : ["decision", "reply"];

  let firstError: unknown;
  for (const field of order) {
    try {
      if (field === "decision") {
        await perm.reply({ sessionID, requestID, decision, message });
      } else {
        await perm.reply({ sessionID, requestID, reply: decision, message });
      }
      if (ctx.permissionReplyField !== field) {
        ctx.permissionReplyField = field;
        if (field === "reply") ctx.log("permission.reply uses the legacy `reply` field");
      }
      return;
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError));
}

/** True when an error means the permission/form was already settled. */
export function isSettledError(error: unknown): boolean {
  const err = error as { code?: unknown; status?: unknown; message?: unknown } | undefined;
  const code = Number(err?.code ?? err?.status);
  if (code === 404 || code === 409 || code === 410) return true;
  const message = String(err?.message ?? error).toLowerCase();
  return /already (answered|replied|resolved|settled)|not found|no pending|does not exist|unknown (request|permission|form)|settled|expired/.test(
    message
  );
}

/** Check if any question reply surface is available on the client. */
export function hasQuestionReplySurface(ctx: AppContext): boolean {
  return !!(
    ctx.client.session?.form?.reply ||
    ctx.client.question?.reply ||
    ctx.client.session?.question?.reply
  );
}

/** Check if any question reject surface is available. */
export function hasQuestionRejectSurface(ctx: AppContext): boolean {
  return !!(ctx.client.question?.reject || ctx.client.session?.question?.reject);
}

/** Log the full error details for debugging permission/form replies. */
export function logReplyError(ctx: AppContext, label: string, error: unknown): void {
  const err = error as
    | { code?: unknown; status?: unknown; message?: unknown; cause?: unknown; response?: unknown }
    | undefined;
  const details = {
    code: err?.code ?? err?.status,
    message: err?.message,
    cause: err?.cause ? String(err.cause).slice(0, 200) : undefined,
    response: err?.response ? String(err.response).slice(0, 200) : undefined,
  };
  ctx.logError(`${label} failed: ${JSON.stringify(details)}`);
}

function questionSurface(ctx: AppContext, scoped?: boolean): LooseQuestion | undefined {
  if (scoped) return ctx.client.session?.question;
  return ctx.client.question;
}

async function replyWithQuestionSurface(
  ctx: AppContext,
  formID: string,
  sessionID: string,
  choice: FormChoice
): Promise<void> {
  // Legacy surfaces expect answer labels; the official form surface below
  // receives machine values.
  const answers = [[choice.label]];
  const surface = questionSurface(ctx);
  if (surface?.reply) {
    await surface.reply({ requestID: formID, answers });
    return;
  }
  const scoped = questionSurface(ctx, true);
  if (scoped?.reply) {
    await scoped.reply({
      requestID: formID,
      sessionID,
      questionV2Reply: { answers },
    });
    return;
  }
  throw new Error("question reply surface not available");
}

/**
 * Answer a pending question (form) from a Telegram tap.
 *
 * Preference order: official `session.form.reply` with the field key and
 * machine value, then the legacy global/scoped `question.reply` with labels.
 * `null` means "skip" and uses `question.reject`. A missing surface throws.
 */
export async function replyQuestion(
  ctx: AppContext,
  formID: string,
  sessionID: string,
  fieldKey: string,
  choice: FormChoice | null
): Promise<void> {
  if (choice === null) {
    // Skip needs a reject surface; prefer the first surface that has one
    // instead of assuming the global surface exposes the full API.
    const surface = [questionSurface(ctx), questionSurface(ctx, true)].find((s) => s?.reject);
    if (!surface?.reject) throw new Error("question reject surface not available");
    await surface.reject({ requestID: formID, sessionID });
    return;
  }

  const form = ctx.client.session?.form;
  if (form?.reply) {
    const answer: FormAnswer = { [fieldKey]: [choice.value] };
    try {
      await form.reply({ sessionID, formID, answer });
      return;
    } catch (error) {
      // Without a fallback surface, surface the real error so settled
      // requests are still recognized instead of being reported as retryable.
      if (!ctx.client.question?.reply && !ctx.client.session?.question?.reply) throw error;
      ctx.log(`session.form.reply failed, trying question.reply: ${String(error)}`);
    }
  }
  await replyWithQuestionSurface(ctx, formID, sessionID, choice);
}

/**
 * One `session.get` call for the completion path: warms the title cache and
 * returns the session's cumulative cost/token counters when the host reports
 * them (opencode v2 sessions do; v1 and minimal surfaces do not, and the
 * caller then simply omits the usage line).
 */
export async function sessionInfo(
  ctx: AppContext,
  sessionID: string
): Promise<{ title?: string; cost?: number; tokens?: TokenUsageInfo } | undefined> {
  const get = ctx.client.session?.get;
  if (!get) return undefined;
  try {
    const info = await get({ sessionID });
    const title = typeof info?.title === "string" && info.title !== "" ? info.title : undefined;
    if (title) ctx.sessionTitles.set(sessionID, title);
    const tokens = info?.tokens;
    return {
      title,
      cost: typeof info?.cost === "number" && Number.isFinite(info.cost) ? info.cost : undefined,
      tokens:
        tokens && typeof tokens.input === "number" && typeof tokens.output === "number"
          ? tokens
          : undefined,
    };
  } catch (error) {
    ctx.logError(`session.get failed: ${String(error)}`);
    return undefined;
  }
}

/** List pending questions for the plugin root, or an empty array when unavailable. */
export async function listPendingQuestions(ctx: AppContext): Promise<unknown[]> {
  const list = questionSurface(ctx)?.list;
  if (!list) return [];
  try {
    const result = await list({ directory: ctx.root });
    if (Array.isArray(result)) return result;
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as { items?: unknown[] }).items)
    ) {
      return (result as { items: unknown[] }).items;
    }
    return [];
  } catch (error) {
    ctx.logError(`question.list failed: ${String(error)}`);
    return [];
  }
}
