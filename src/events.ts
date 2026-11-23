/**
 * opencode-telegram-notify — event router.
 *
 * Maps opencode v2 events to Telegram notifications:
 *   permission.asked            → 🔐 message + tap-only buttons
 *   permission.replied          → close the notification ("answered")
 *   form.created                → ❓ question: tap buttons for one choice field
 *                                 (answer via form/question reply, skip via
 *                                 form cancel/question reject),
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
import type { Language } from "./config.ts";
import {
  type AppContext,
  type ChoiceFieldType,
  type FormChoice,
  hasQuestionReplySurface,
  hasQuestionSkipSurface,
  listPendingQuestions,
  sessionInfo,
  trimMap,
  trimSet,
} from "./context.ts";
import * as fmt from "./format.ts";
import { decisionLabel, t } from "./i18n/index.ts";
import type { InlineButton } from "./telegram.ts";
import type {
  ExecutionData,
  FormCancelledData,
  FormCreatedData,
  FormRepliedData,
  PermissionAskedData,
  PermissionRepliedData,
  SessionAgentSelectedData,
  SessionCreatedData,
  SessionDeletedData,
  V2EventEnvelope,
} from "./types.ts";

const SEEN_SYMBOL = Symbol.for("opencode-telegram-notify/seen-events");
const SEEN_MAX = 2000;
/** Maximum sessions inspected in a parentID chain, including the start. */
const MAX_PARENT_NODES = 8;

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
}

/** Events whose data carries a sessionID at the top level. */
function dataSessionID(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const sid = (data as { sessionID?: unknown }).sessionID;
  return typeof sid === "string" ? sid : undefined;
}

function permissionButtons(lang: Language): InlineButton[][] {
  return [
    [
      { text: t(lang, "answerOnce"), callback_data: "allow" },
      { text: t(lang, "answerReject"), callback_data: "reject" },
    ],
    [{ text: t(lang, "answerAlways"), callback_data: "always" }],
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
  const state: RouterState = { idleTimers: new Map(), idleSentAt: new Map() };

  const cfg = ctx.config;
  const canTap = () => cfg.interactions && ctx.interactive;
  // Lowercased once: matching happens on every notify-worthy event. Empty
  // needles are dropped because `"".includes("")` would mute everything.
  const ignoreTitles = cfg.ignore.titles
    .map((needle) => needle.toLowerCase())
    .filter((needle) => needle !== "");
  const ignoreAgents = cfg.ignore.agents
    .map((needle) => needle.toLowerCase())
    .filter((needle) => needle !== "");
  const ignoreActive = ignoreTitles.length > 0 || ignoreAgents.length > 0;
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

  /** Why this session is ignored, or undefined when it should notify. */
  function ignoredReason(sessionID: string): string | undefined {
    const title = ctx.sessionTitles.get(sessionID);
    if (title) {
      const haystack = title.toLowerCase();
      const hit = ignoreTitles.find((needle) => haystack.includes(needle));
      if (hit) return `title "${title}" matches "${hit}"`;
    }
    const agent = ctx.sessionAgents.get(sessionID);
    if (agent && ignoreAgents.includes(agent.toLowerCase())) return `agent "${agent}" is ignored`;
    return undefined;
  }

  /**
   * Whether a `session.get` is worth one round trip: only when a configured
   * selector is still missing and this session was never looked up. A host that
   * reports no agent leaves the cache empty forever, so the attempt itself has
   * to be remembered.
   */
  function needsLookup(sessionID: string): boolean {
    if (ctx.sessionLookups.has(sessionID) || !ctx.client.session?.get) return false;
    return (
      (ignoreTitles.length > 0 && !ctx.sessionTitles.has(sessionID)) ||
      (ignoreAgents.length > 0 && !ctx.sessionAgents.has(sessionID))
    );
  }

  /** Match one session's own title/agent, resolving it once when needed. */
  async function ignoredSessionReason(sessionID: string): Promise<string | undefined> {
    let reason = ignoredReason(sessionID);
    if (reason === undefined && needsLookup(sessionID)) {
      await sessionInfo(ctx, sessionID);
      reason = ignoredReason(sessionID);
    }
    return reason;
  }

  /** Resolve whether this session is a subagent; null/undefined means no. */
  async function isSubagent(sessionID: string): Promise<boolean> {
    const parent = ctx.sessionParents.get(sessionID);
    if (parent !== undefined) return parent !== null;
    if (!ctx.client.session?.get || ctx.sessionLookups.has(sessionID)) return false;
    await sessionInfo(ctx, sessionID);
    return typeof ctx.sessionParents.get(sessionID) === "string";
  }

  /**
   * Session-level mute for background/automation runs.
   *
   * A muted session produces no completion, failure, permission or question
   * message, so the chat stays quiet while nobody is at the terminal. Titles
   * match as case-insensitive substrings (hosts append suffixes), agents as
   * case-insensitive exact names.
   *
   * Muting only suppresses the message: the permission or question itself is
   * untouched, so the run behaves exactly as if the plugin were not installed.
   *
   * Rules are inherited through `parentID`: a subagent of a muted run is muted
   * too, even when its own title/agent does not match. The caches are filled by
   * `session.created`; a session that started before the plugin (re)loaded is
   * resolved through `session.get` on its first event, and the successful
   * lookup is remembered so a host that reports no agent does not get asked
   * again for every later event.
   */
  async function muted(sessionID: string | undefined): Promise<boolean> {
    if (!sessionID || !ignoreActive) return false;
    const visited = new Set<string>();
    let current: string | null | undefined = sessionID;
    for (let depth = 0; current && depth < MAX_PARENT_NODES; depth++) {
      if (visited.has(current)) break;
      visited.add(current);
      const reason = await ignoredSessionReason(current);
      if (reason !== undefined) {
        const via = current === sessionID ? "" : ` via parent ${current}`;
        ctx.log(`ignoring session ${sessionID}${via}: ${reason}`);
        return true;
      }
      current = ctx.sessionParents.get(current);
    }
    return false;
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
    if (await muted(req.sessionID)) return;
    // /stop may have run while the mute lookup was in flight.
    if (ctx.silenced) return;
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
      // Drop the marker so a host that redelivers the event can send again.
      ctx.permMsgs.delete(req.id);
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
          ? t(cfg.language, "doneRejected")
          : t(cfg.language, "doneAllowed", {
              decision: decisionLabel(cfg.language, reply.reply ?? "once"),
            });
      await ctx.telegram.editMessageText(messageId, fmt.escapeHtml(text));
    } catch (error) {
      ctx.logError(`permission close edit failed: ${String(error)}`);
    }
  }

  /**
   * The tap-answerable surface covers one choice field with 2..5 options.
   * String fields send the selected value; multiselect fields send a one-item
   * array. Everything else stays notify-only; the message then points back to
   * the terminal (formatQuestion plain mode).
   */
  function singleQuestionChoices(
    form: FormCreatedData["form"]
  ): { fieldKey: string; fieldType: ChoiceFieldType; choices: FormChoice[] } | undefined {
    const fields = form.fields ?? [];
    if (fields.length !== 1) return undefined;
    const field = fields[0];
    const options = field?.options ?? [];
    if (!field || (field.type !== "string" && field.type !== "multiselect")) return undefined;
    if (options.length < 2 || options.length > 5) return undefined;
    return {
      fieldKey: field.key,
      fieldType: field.type,
      choices: options.map((o) => ({ value: o.value, label: o.label || o.value })),
    };
  }

  function questionButtons(choices: FormChoice[], withSkip: boolean): InlineButton[][] {
    const rows: InlineButton[][] = choices.map((choice, i) => [
      { text: choice.label.slice(0, 60), callback_data: `q:${i}` },
    ]);
    if (withSkip) rows.push([{ text: t(cfg.language, "questionSkip"), callback_data: "qskip" }]);
    return rows;
  }

  async function notifyQuestion(data: unknown): Promise<void> {
    if (ctx.silenced || !cfg.events.question) return;
    const created = data as FormCreatedData;
    const form = created?.form;
    if (!form || typeof form.id !== "string") return;
    if (ctx.formMsgs.has(form.id)) return; // already notified (restart recovery dedupe)
    if (await muted(form.sessionID)) return;
    // /stop may have run while the mute lookup was in flight.
    if (ctx.silenced) return;
    // Register synchronously so a live form.created racing the recovery
    // startup window cannot duplicate the notification either.
    ctx.formMsgs.set(form.id, -1);
    const question = singleQuestionChoices(form);
    const hasSurface = hasQuestionReplySurface(ctx);
    const buttons =
      question && canTap() && hasSurface
        ? questionButtons(question.choices, hasQuestionSkipSurface(ctx))
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
          fieldType: question.fieldType,
          options: question.choices,
        });
        trimMap(ctx.pendingForms);
      }
      trimMap(ctx.formMsgs);
    } catch (error) {
      // Drop the marker so a host that redelivers the event can send again.
      ctx.formMsgs.delete(form.id);
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
      const text = cancelled ? t(cfg.language, "doneCancelled") : t(cfg.language, "doneAnswered");
      await ctx.telegram.editMessageText(messageId, `<b>${fmt.escapeHtml(text)}</b>`);
    } catch (error) {
      ctx.logError(`question close edit failed: ${String(error)}`);
    }
  }

  function scheduleIdle(sessionID: string): void {
    if (ctx.silenced || !cfg.events.idle) return;
    if (typeof ctx.sessionParents.get(sessionID) === "string") return; // subagent noise
    cancelIdle(sessionID);
    // The timer stays in the map until it finishes, so cancelIdle() during one
    // of the awaits below invalidates the pending send instead of losing the
    // handle and letting a stale (or duplicate) completion through.
    let handle: ReturnType<typeof setTimeout> | undefined;
    const current = () => handle !== undefined && state.idleTimers.get(sessionID) === handle;
    handle = setTimeout(async () => {
      try {
        if (!current()) return;
        // Settings can change while the timer is pending (/stop).
        if (ctx.silenced || !cfg.events.idle) return;
        // A rename or agent switch inside the debounce window must not leak a
        // notification for a session that is ignored now.
        if (await muted(sessionID)) return;
        if (!current()) return;
        // Interactive sessions pause often; at most one completion notification
        // per idleCooldownMs, so conversational pauses do not spam the chat.
        const last = state.idleSentAt.get(sessionID) ?? 0;
        if (Date.now() - last < cfg.idleCooldownMs) return;
        // One lookup warms the title cache (header "Session: …") and, when the
        // host reports them, the cumulative cost/token counters for the usage
        // line; the project name stays as the fallback header.
        const info = await sessionInfo(ctx, sessionID);
        // A new run (or a mute) landed during the lookup: drop this one.
        if (!current()) return;
        // The lookup may have discovered a parentID for a cold subagent.
        if (await isSubagent(sessionID)) return;
        // A rename or agent switch may also have landed during that lookup.
        if (await muted(sessionID)) return;
        // /stop or a newer run may have landed during the mute lookup too.
        if (!current() || ctx.silenced) return;
        state.idleSentAt.set(sessionID, Date.now());
        trimMap(state.idleSentAt);
        void ctx.telegram
          .sendMessage(fmt.formatCompleted(sessionID, fctx, cfg.events.usage ? info : undefined))
          .catch((error) => ctx.logError(`completed notify failed: ${String(error)}`));
      } catch (error) {
        ctx.logError(`completed notify failed: ${String(error)}`);
      } finally {
        if (current()) state.idleTimers.delete(sessionID);
      }
    }, cfg.idleDebounceMs);
    // Never keep a server process alive only because a completion notification
    // is pending (matters for plugin hosts without a dispose chain, i.e. v1).
    (handle as unknown as { unref?: () => void }).unref?.();
    state.idleTimers.set(sessionID, handle);
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
            // Only an explicit parentID is authoritative here. A sparse title
            // update (v1 maps session.updated to session.created) must not
            // downgrade a known child; a successful session.get settles the
            // top-level case with null.
            if (d.parentID) {
              ctx.sessionParents.set(d.sessionID, d.parentID);
              trimMap(ctx.sessionParents);
            }
            const title = d.title ?? d.slug;
            if (title) {
              ctx.sessionTitles.set(d.sessionID, title);
              trimMap(ctx.sessionTitles);
            }
            if (d.agent) {
              ctx.sessionAgents.set(d.sessionID, d.agent);
              trimMap(ctx.sessionAgents);
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
        case "session.agent.selected": {
          const d = data as SessionAgentSelectedData;
          if (typeof d?.sessionID !== "string") return;
          if (typeof d.agent === "string" && d.agent !== "") {
            ctx.sessionAgents.set(d.sessionID, d.agent);
            trimMap(ctx.sessionAgents);
          } else {
            // Agent-less switch: drop the stale value and allow one fresh
            // lookup instead of keeping the old agent forever.
            ctx.sessionAgents.delete(d.sessionID);
            ctx.sessionLookups.delete(d.sessionID);
          }
          return;
        }
        case "session.deleted": {
          const d = data as SessionDeletedData;
          const sid = typeof d?.sessionID === "string" ? d.sessionID : undefined;
          if (!sid) return;
          cancelIdle(sid);
          state.idleSentAt.delete(sid);
          ctx.sessionTitles.delete(sid);
          ctx.sessionAgents.delete(sid);
          // Keep the lookup marker so a surviving child does not retry
          // session.get for a deleted ancestor. Parent links are kept on both
          // sides too: they preserve subagent lifecycle suppression and let a
          // surviving grandchild reach a live muted grandparent. OpenCode
          // normally deletes children recursively.
          ctx.sessionLookups.add(sid);
          trimSet(ctx.sessionLookups);
          ctx.sessionDirs.delete(sid);
          // Drop the tap targets for this session's messages, so a late tap
          // cannot answer a request from a deleted session. Close bookkeeping
          // (permMsgs/formMsgs) stays: the maps are bounded, a late reply can
          // still edit the message, and redelivered events stay deduped.
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
          if (!d?.sessionID) return;
          // A new run supersedes a completion still inside its debounce window.
          // Cancel before any await so a slow mute lookup cannot let it fire.
          cancelIdle(d.sessionID);
          if (await muted(d.sessionID)) return;
          scheduleIdle(d.sessionID);
          return;
        }
        case "session.execution.failed": {
          const d = data as ExecutionData;
          if (!d?.sessionID) return;
          // The run is over: a pending completion must not arrive after it,
          // even when failures are not announced or the session is muted.
          cancelIdle(d.sessionID);
          if (ctx.silenced || !cfg.events.error) return;
          if (await isSubagent(d.sessionID)) return; // subagent noise
          if (await muted(d.sessionID)) return;
          // /stop may have run while the mute lookup was in flight.
          if (ctx.silenced) return;
          await ctx.telegram
            .sendMessage(fmt.formatFailed(d.error, fctx))
            .catch((error) => ctx.logError(`failed notify: ${String(error)}`));
          return;
        }
        case "session.execution.interrupted": {
          const d = data as ExecutionData;
          if (!d?.sessionID) return;
          cancelIdle(d.sessionID);
          if (ctx.silenced || !cfg.events.error) return;
          if (await isSubagent(d.sessionID)) return; // subagent noise
          if (await muted(d.sessionID)) return;
          // /stop may have run while the mute lookup was in flight.
          if (ctx.silenced) return;
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
