/**
 * opencode-telegram-notify — event router.
 *
 * Maps opencode v2 events to Telegram notifications:
 *   permission.asked            → 🔐 message + tap-only buttons
 *   permission.replied          → close the notification ("answered")
 *   form.created                → ❓ question: tap buttons for single-select
 *                                 forms (answer/reject via question.reply),
 *                                 notify-only otherwise
 *   form.replied / cancelled    → close the question message
 *   session.execution.succeeded → ✅ completed (debounced)
 *   session.execution.failed    → ❌ failed
 *   session.execution.interrupted → ⏹ cancelled
 *
 * Contract guardrails implemented here:
 *   - ownership gate (global stream; only sessions of this root are handled);
 *   - process-level seen-event set (multi-activation dedupe, Symbol.for id);
 *   - idle debounce (activity cancels the notification);
 *   - subagent sessions (parentID) never produce lifecycle notifications.
 */

import { resolve as resolvePath } from "node:path";
import {
  type AppContext,
  type FormChoice,
  hasQuestionRejectSurface,
  hasQuestionReplySurface,
  listPendingQuestions,
  sessionTitle,
} from "./context.ts";
import * as fmt from "./format.ts";
import {
  ANSWER_ALWAYS,
  ANSWER_ONCE,
  ANSWER_REJECT,
  DONE_ALLOWED,
  DONE_ANSWERED,
  DONE_CANCELLED,
  DONE_REJECTED,
  decisionLabel,
  QUESTION_SKIP,
  tr,
} from "./i18n.ts";
import type { InlineButton } from "./telegram.ts";
import type {
  ExecutionData,
  FormCancelledData,
  FormCreatedData,
  FormRepliedData,
  PermissionAskedData,
  PermissionRepliedData,
  SessionCreatedData,
  SessionDeletedData,
  V2EventEnvelope,
} from "./types.ts";

const SEEN_SYMBOL = Symbol.for("opencode-telegram-notify/seen-events");
const SEEN_MAX = 2000;
const CACHE_MAX = 500;

/** Drop oldest insertion-order entries so long-lived hosts stay bounded. */
function trimMap<K, V>(map: Map<K, V>, max = CACHE_MAX): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function trimSet<T>(set: Set<T>, max = CACHE_MAX): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

/** Process-level seen-event registry; survives plugin reloads in one process. */
function seenSet(): Set<string> {
  const store = globalThis as unknown as Record<symbol, Set<string>>;
  let set = store[SEEN_SYMBOL];
  if (!set) {
    set = new Set<string>();
    store[SEEN_SYMBOL] = set;
  }
  return set;
}

const seen = seenSet();

/**
 * Normalize either a wrapped FormCreatedData (event payload shape) or a bare
 * pending question (question.list item shape) into notify input, or undefined
 * when the shape is not a recognizable question.
 */
function toFormCreatedData(raw: unknown): FormCreatedData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as {
    form?: { id?: unknown; sessionID?: unknown; title?: unknown; fields?: unknown };
    id?: unknown;
    sessionID?: unknown;
    title?: unknown;
    fields?: unknown;
  };
  if (typeof item.form?.id === "string") return raw as FormCreatedData;
  if (typeof item.id === "string" && typeof item.sessionID === "string") {
    return {
      form: {
        id: item.id,
        sessionID: item.sessionID,
        title: typeof item.title === "string" ? item.title : "",
        fields: Array.isArray(item.fields)
          ? (item.fields as FormCreatedData["form"]["fields"])
          : [],
      },
    };
  }
  return undefined;
}

/** @internal clear the process-level dedupe set (test hook). */
export function resetProcessEventDedupe(): void {
  seen.clear();
}

/** Activity markers — any of these cancels a pending idle notification. */
const ACTIVITY_TYPES = new Set([
  "session.execution.started",
  "session.step.started",
  "session.tool.called",
  "session.tool.input.started",
  "session.tool.input.ended",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.text.delta",
  "session.reasoning.delta",
  "session.inbox.enqueued",
]);

interface RouterState {
  /** sessionID -> timeout handle for the debounced completion notification. */
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** sessionID -> timestamp of the last completion notification (cooldown). */
  idleSentAt: Map<string, number>;
  /** sessionIDs created as child sessions (parentID set). */
  children: Set<string>;
}

/** Events whose data carries a sessionID at the top level. */
function dataSessionID(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const sid = (data as { sessionID?: unknown }).sessionID;
  return typeof sid === "string" ? sid : undefined;
}

function permissionButtons(lang: "en" | "it"): InlineButton[][] {
  return [
    [
      { text: ANSWER_ONCE[lang], callback_data: "allow" },
      { text: ANSWER_REJECT[lang], callback_data: "reject" },
    ],
    [{ text: ANSWER_ALWAYS[lang], callback_data: "always" }],
  ];
}

export interface RouterOptions {
  /** Tests and the app call recover() when this instance owns the poller. */
  autoRecover?: boolean;
}

export function createRouter(
  ctx: AppContext,
  options: RouterOptions = {}
): {
  handle: (envelope: V2EventEnvelope) => Promise<void>;
  dispose: () => void;
  recover: () => Promise<void>;
} {
  const state: RouterState = { idleTimers: new Map(), idleSentAt: new Map(), children: new Set() };

  const cfg = ctx.config;
  const canTap = () => cfg.interactions && ctx.interactive;
  const fctx = {
    language: cfg.language,
    hideCommands: cfg.hideCommands,
    maxBody: cfg.maxMessageChars,
    project: ctx.project,
    sessionTitle: (sessionID: string) => ctx.sessionTitles.get(sessionID),
  };

  /** Ownership gate — exactly one instance per root handles an event. */
  function owns(envelope: V2EventEnvelope): boolean {
    const dir = envelope.location?.directory;
    if (dir) {
      const resolved = resolvePath(dir);
      const sid = dataSessionID(envelope.data) ?? formSessionID(envelope.data);
      if (sid) {
        ctx.sessionDirs.set(sid, resolved);
        trimMap(ctx.sessionDirs);
      }
      return resolved === ctx.root;
    }
    const sid = dataSessionID(envelope.data) ?? formSessionID(envelope.data);
    if (!sid) return false; // unattributable → skip
    const attributed = ctx.sessionDirs.get(sid);
    return attributed === ctx.root;
  }

  function formSessionID(data: unknown): string | undefined {
    if (!data || typeof data !== "object") return undefined;
    const form = (data as { form?: { sessionID?: unknown } }).form?.sessionID;
    return typeof form === "string"
      ? form
      : ((data as { sessionID?: unknown }).sessionID as string | undefined);
  }

  function markSeen(id: string): boolean {
    if (seen.has(id)) return false;
    if (seen.size >= SEEN_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(id);
    return true;
  }

  function cancelIdle(sessionID: string): void {
    const t = state.idleTimers.get(sessionID);
    if (t === undefined) return;
    clearTimeout(t);
    state.idleTimers.delete(sessionID);
  }

  async function notifyPermission(data: unknown): Promise<void> {
    if (ctx.silenced || !cfg.events.permission) return;
    const req = data as PermissionAskedData;
    if (!req || typeof req.id !== "string") return;
    if (ctx.permMsgs.has(req.id)) return;
    // Register before the network call so a fast reply/restart cannot race a
    // duplicate notification; -1 means "send in flight / not tap-answerable".
    ctx.permMsgs.set(req.id, -1);
    const buttons = canTap() ? permissionButtons(cfg.language) : undefined;
    const body = fmt.formatPermission(req, fctx, buttons ? "buttons" : "plain");
    try {
      const messageId = await ctx.telegram.sendMessage(body, { buttons });
      ctx.permMsgs.set(req.id, messageId ?? -1);
      if (messageId !== undefined && buttons) {
        ctx.pending.set(messageId, {
          sessionID: req.sessionID,
          requestID: req.id,
          action: req.action,
        });
        trimMap(ctx.pending);
      }
      trimMap(ctx.permMsgs);
    } catch (error) {
      ctx.permMsgs.delete(req.id); // allow a later retry after a send failure
      ctx.logError(`permission notify failed: ${String(error)}`);
    }
  }

  async function closePermission(data: unknown): Promise<void> {
    const reply = data as PermissionRepliedData;
    if (!reply || typeof reply.requestID !== "string") return;
    const messageId = ctx.permMsgs.get(reply.requestID);
    if (messageId === undefined) return;
    ctx.permMsgs.delete(reply.requestID);
    if (messageId < 0) return;
    ctx.pending.delete(messageId);
    try {
      const text =
        reply.reply === "reject"
          ? DONE_REJECTED[cfg.language]
          : tr(cfg.language, DONE_ALLOWED, {
              decision: decisionLabel(cfg.language, reply.reply ?? "once"),
            });
      await ctx.telegram.editMessageText(messageId, fmt.escapeHtml(text));
    } catch (error) {
      ctx.logError(`permission close edit failed: ${String(error)}`);
    }
  }

  /**
   * The tap-answerable surface covers single-select questions only: exactly
   * one field with 2..5 options. Everything else stays notify-only; the
   * message then points back to the terminal (formatQuestion plain mode).
   */
  function singleQuestionChoices(
    form: FormCreatedData["form"]
  ): { fieldKey: string; choices: FormChoice[] } | undefined {
    const fields = form.fields ?? [];
    if (fields.length !== 1) return undefined;
    const field = fields[0];
    const options = field?.options ?? [];
    if (!field || options.length < 2 || options.length > 5) return undefined;
    return {
      fieldKey: field.key,
      choices: options.map((o) => ({ value: o.value, label: o.label || o.value })),
    };
  }

  function questionButtons(choices: FormChoice[], withSkip: boolean): InlineButton[][] {
    const rows: InlineButton[][] = choices.map((choice, i) => [
      { text: choice.label.slice(0, 60), callback_data: `q:${i}` },
    ]);
    if (withSkip) rows.push([{ text: QUESTION_SKIP[cfg.language], callback_data: "qskip" }]);
    return rows;
  }

  async function notifyQuestion(data: unknown): Promise<void> {
    if (ctx.silenced || !cfg.events.question) return;
    const created = data as FormCreatedData;
    const form = created?.form;
    if (!form || typeof form.id !== "string") return;
    if (ctx.formMsgs.has(form.id)) return; // already notified (restart recovery dedupe)
    // Register synchronously so a live form.created racing the recovery
    // startup window cannot duplicate the notification either.
    ctx.formMsgs.set(form.id, -1);
    const question = singleQuestionChoices(form);
    const hasSurface = hasQuestionReplySurface(ctx);
    const buttons =
      question && canTap() && hasSurface
        ? questionButtons(question.choices, hasQuestionRejectSurface(ctx))
        : undefined;
    if (question && canTap() && !hasSurface) {
      ctx.log(`question surface not available for form ${form.id}, sending notify-only`);
    }
    try {
      const messageId = await ctx.telegram.sendMessage(
        fmt.formatQuestion(created, fctx, buttons ? "buttons" : "plain"),
        buttons ? { buttons } : {}
      );
      ctx.formMsgs.set(form.id, messageId ?? -1);
      if (question && buttons && messageId !== undefined) {
        ctx.pendingForms.set(messageId, {
          formID: form.id,
          sessionID: form.sessionID,
          fieldKey: question.fieldKey,
          options: question.choices,
        });
        trimMap(ctx.pendingForms);
      }
      trimMap(ctx.formMsgs);
    } catch (error) {
      ctx.formMsgs.delete(form.id); // allow a later retry after a send failure
      ctx.logError(`question notify failed: ${String(error)}`);
    }
  }

  async function closeQuestion(data: unknown, cancelled: boolean): Promise<void> {
    const id = cancelled
      ? (data as FormCancelledData | undefined)?.id
      : (data as FormRepliedData | undefined)?.id;
    if (typeof id !== "string") return;
    const messageId = ctx.formMsgs.get(id);
    if (messageId === undefined || messageId < 0) {
      ctx.formMsgs.delete(id);
      return;
    }
    ctx.formMsgs.delete(id);
    ctx.pendingForms.delete(messageId);
    try {
      const text = cancelled ? DONE_CANCELLED[cfg.language] : DONE_ANSWERED[cfg.language];
      await ctx.telegram.editMessageText(messageId, `<b>${fmt.escapeHtml(text)}</b>`);
    } catch (error) {
      ctx.logError(`question close edit failed: ${String(error)}`);
    }
  }

  function scheduleIdle(sessionID: string): void {
    if (ctx.silenced || !cfg.events.idle) return;
    if (state.children.has(sessionID)) return; // subagent noise
    cancelIdle(sessionID);
    const t = setTimeout(async () => {
      state.idleTimers.delete(sessionID);
      // Settings can change while the timer is pending (/stop).
      if (ctx.silenced || !cfg.events.idle) return;
      // Interactive sessions pause often; at most one completion notification
      // per idleCooldownMs, so conversational pauses do not spam the chat.
      const last = state.idleSentAt.get(sessionID) ?? 0;
      if (Date.now() - last < cfg.idleCooldownMs) return;
      state.idleSentAt.set(sessionID, Date.now());
      trimMap(state.idleSentAt);
      // Warm the title cache so the header can show "Session: …"; the project
      // name is always present as a fallback.
      await sessionTitle(ctx, sessionID);
      void ctx.telegram
        .sendMessage(fmt.formatCompleted(sessionID, fctx))
        .catch((error) => ctx.logError(`completed notify failed: ${String(error)}`));
    }, cfg.idleDebounceMs);
    // Never keep a server process alive only because a completion notification
    // is pending (matters for plugin hosts without a dispose chain, i.e. v1).
    (t as unknown as { unref?: () => void }).unref?.();
    state.idleTimers.set(sessionID, t);
  }

  async function handle(envelope: V2EventEnvelope): Promise<void> {
    if (!owns(envelope)) return;
    if (!markSeen(envelope.id)) return;

    const type = envelope.type;
    const data = envelope.data;
    if (ACTIVITY_TYPES.has(type)) {
      const sid = dataSessionID(data);
      if (sid) cancelIdle(sid);
      return;
    }
    try {
      switch (type) {
        case "session.created": {
          const d = data as SessionCreatedData;
          if (d?.sessionID) {
            if (d.parentID) {
              state.children.add(d.sessionID);
              trimSet(state.children);
            }
            const title = d.title ?? d.slug;
            if (title) {
              ctx.sessionTitles.set(d.sessionID, title);
              trimMap(ctx.sessionTitles);
            }
          }
          return;
        }
        case "session.renamed": {
          const d = data as { sessionID: string; title?: string };
          if (d?.sessionID && d.title) {
            ctx.sessionTitles.set(d.sessionID, d.title);
            trimMap(ctx.sessionTitles);
          }
          return;
        }
        case "session.deleted": {
          const d = data as SessionDeletedData;
          const sid = typeof d?.sessionID === "string" ? d.sessionID : undefined;
          if (!sid) return;
          cancelIdle(sid);
          state.children.delete(sid);
          state.idleSentAt.delete(sid);
          ctx.sessionTitles.delete(sid);
          ctx.sessionDirs.delete(sid);
          for (const [messageId, pending] of ctx.pending) {
            if (pending.sessionID === sid) ctx.pending.delete(messageId);
          }
          for (const [messageId, pending] of ctx.pendingForms) {
            if (pending.sessionID === sid) ctx.pendingForms.delete(messageId);
          }
          return;
        }
        case "permission.asked":
          return await notifyPermission(data);
        case "permission.replied":
          return await closePermission(data);
        case "form.created":
          return await notifyQuestion(data);
        case "form.replied":
          return await closeQuestion(data, false);
        case "form.cancelled":
          return await closeQuestion(data, true);
        case "session.execution.succeeded": {
          const d = data as ExecutionData;
          if (d?.sessionID) scheduleIdle(d.sessionID);
          return;
        }
        case "session.execution.failed": {
          const d = data as ExecutionData;
          if (!d?.sessionID || ctx.silenced || !cfg.events.error) return;
          cancelIdle(d.sessionID);
          await ctx.telegram
            .sendMessage(fmt.formatFailed(d.error, fctx))
            .catch((error) => ctx.logError(`failed notify: ${String(error)}`));
          return;
        }
        case "session.execution.interrupted": {
          const d = data as ExecutionData;
          if (!d?.sessionID || ctx.silenced || !cfg.events.error) return;
          cancelIdle(d.sessionID);
          await ctx.telegram
            .sendMessage(fmt.formatCancelled(d.sessionID, fctx), { silent: true })
            .catch((error) => ctx.logError(`cancelled notify: ${String(error)}`));
          return;
        }
        default:
          return;
      }
    } catch (error) {
      ctx.logError(`handle ${type} failed: ${String(error)}`);
    }
  }

  function dispose(): void {
    for (const t of state.idleTimers.values()) clearTimeout(t);
    state.idleTimers.clear();
  }

  /** Restore tap-buttons for questions that were pending before a restart. */
  async function recoverPendingQuestions(): Promise<void> {
    if (ctx.silenced || !cfg.events.question || !ctx.interactive) return;
    try {
      for (const raw of await listPendingQuestions(ctx)) {
        const data = toFormCreatedData(raw);
        if (data) await notifyQuestion(data);
      }
    } catch (error) {
      ctx.logError(`question recovery failed: ${String(error)}`);
    }
  }

  if (options.autoRecover !== false) void recoverPendingQuestions();

  return { handle, dispose, recover: recoverPendingQuestions };
}
