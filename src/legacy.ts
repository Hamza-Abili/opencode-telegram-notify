/**
 * opencode-telegram-notify — OpenCode v1 (pre-2.0) adapter.
 *
 * OpenCode v2 loads plugins from the default export as `{id, setup}`;
 * v1 hosts instead load a *factory function* and deliver bus events through
 * hooks, with permissions answered over the SDK HTTP surface. This module
 * exposes the legacy entry point as the `./legacy` package export:
 *
 *   opencode.json (v1): { "plugin": ["@hamzaabili/opencode-telegram-notify/legacy"] }
 *
 * Everything above the version split (config, telegram client, i18n, router,
 * poller, poller lock) is shared with the v2 path — only the transport and
 * the event wire format differ.
 *
 * v1 contract (verified against the opencode 1.x SDK typings across two
 * permission generations):
 *   input    { client, project, directory, worktree, $ }
 *   hooks    { event({ event }) }  with event: { type, properties }
 *   reply    POST /session/{id}/permissions/{permissionID}  body { response }
 *   events   permissions arrive as `permission.updated` (pre-rework hosts:
 *            {id, sessionID, title, metadata}) or `permission.asked`
 *            (post-rework v1.x: {id, sessionID, permission, patterns,
 *            metadata, always, tool?}); replies arrive as
 *            `permission.replied` with either {permissionID, response} or
 *            {requestID, reply}; plus session.created/updated/deleted,
 *            session.status, session.idle, session.error.
 *
 * Mapping notes:
 *   - `MessageAbortedError` maps to `session.execution.interrupted` (silent),
 *     not to an error notification — a user abort is not a failure.
 *   - Envelope ids for permission events are derived from the permission id
 *     (stable across replays); lifecycle ids are occurrence-unique because the
 *     v1 bus has no event ids and repeats of a lifecycle event are legitimate
 *     new turns.
 *   - v1 has no `form.*` question flow, so questions are simply not available.
 */

import { createApp } from "./app.ts";
import type { PermissionDecision, V2Client, V2EventEnvelope } from "./types.ts";

/* ----------------------------- v1 input types ----------------------------- */

/** Minimal opencode v1 plugin input (extra fields ignored). */
export interface V1PluginInput {
  client?: unknown;
  directory?: unknown;
  worktree?: unknown;
}

interface V1SdkClient {
  postSessionIdPermissionsPermissionId(input: {
    path: { id: string; permissionID: string };
    query?: { directory?: string };
    body: { response: PermissionDecision };
  }): Promise<unknown>;
}

/** Optional modern variant: `permission.reply({requestID, reply, message})`. */
interface V1SdkPermissionReply {
  reply(input: {
    requestID: string;
    reply: PermissionDecision;
    message?: string;
  }): Promise<unknown>;
}

/** Pre-rework permission event payload. */
interface V1Permission {
  id: string;
  sessionID: string;
  title: string;
  metadata?: { [key: string]: unknown };
  time?: { created: number };
}

/** Post-rework v1.x permission event payload. */
interface V1Asked {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: { [key: string]: unknown };
  always?: string[];
  tool?: { messageID: string; callID: string };
}

/** Reply event payload — field names differ between v1 generations. */
interface V1Replied {
  sessionID?: string;
  permissionID?: string;
  requestID?: string;
  response?: string;
  reply?: string;
}

/** Subset of the v1 `Session` info payload. */
interface V1Session {
  id: string;
  parentID?: string;
  title?: string;
  time?: { updated?: number };
}

/** Subset of the v1 session error payloads. */
interface V1Error {
  name?: string;
  data?: { message?: string };
}

/* --------------------------- event wire mapping --------------------------- */

const RESOURCE_KEYS = ["command", "path", "file", "pattern", "glob", "url"] as const;

function metadataResources(metadata: { [key: string]: unknown } | undefined): string[] {
  const out: string[] = [];
  if (!metadata) return out;
  for (const key of RESOURCE_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim() !== "") out.push(value.trim());
    else if (typeof value === "number") out.push(String(value));
    else if (Array.isArray(value)) {
      for (const item of value)
        if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
    }
  }
  return out;
}

/**
 * Pure, stateful-light mapper from one v1 bus event to the internal v2-style
 * envelope. Returns undefined for events that do not concern notifications.
 */
export function createV1EventMapper(
  directory: string
): (event: unknown) => V2EventEnvelope | undefined {
  let occurrence = 0;
  const titles = new Map<string, string>();
  const knownParents = new Set<string>();
  const location = { directory };

  return (event) => {
    const ev = event as { type?: unknown; properties?: unknown } | undefined;
    if (!ev || typeof ev.type !== "string") return undefined;
    const props = (ev.properties ?? {}) as Record<string, unknown>;

    switch (ev.type) {
      case "permission.updated": {
        const perm = props as unknown as V1Permission;
        if (
          typeof perm?.id !== "string" ||
          typeof perm?.sessionID !== "string" ||
          typeof perm?.title !== "string"
        ) {
          return undefined;
        }
        return {
          id: `v1:permission.asked:${perm.id}`,
          type: "permission.asked",
          created: perm.time?.created,
          location,
          data: {
            id: perm.id,
            sessionID: perm.sessionID,
            action: perm.title,
            resources: metadataResources(perm.metadata),
          },
        };
      }

      case "permission.asked": {
        const asked = props as unknown as V1Asked;
        if (
          typeof asked?.id !== "string" ||
          typeof asked?.sessionID !== "string" ||
          typeof asked?.permission !== "string"
        ) {
          return undefined;
        }
        const resources = [...(asked.patterns ?? []), ...metadataResources(asked.metadata)];
        return {
          id: `v1:permission.asked:${asked.id}`,
          type: "permission.asked",
          location,
          data: {
            id: asked.id,
            sessionID: asked.sessionID,
            action: asked.permission,
            resources,
            save: asked.always,
            source:
              asked.tool !== undefined
                ? { type: "tool", messageID: asked.tool.messageID, id: asked.tool.callID }
                : undefined,
          },
        };
      }

      case "permission.replied": {
        const reply = props as unknown as V1Replied;
        const requestID = reply?.requestID ?? reply?.permissionID;
        const verb = reply?.reply ?? reply?.response;
        if (typeof requestID !== "string") return undefined;
        if (verb !== "once" && verb !== "always" && verb !== "reject") return undefined;
        return {
          id: `v1:permission.replied:${requestID}:${verb}`,
          type: "permission.replied",
          location,
          data: {
            sessionID: typeof reply.sessionID === "string" ? reply.sessionID : "",
            requestID,
            reply: verb,
          },
        };
      }

      case "session.created":
      case "session.updated": {
        const session = (props as { info?: V1Session })?.info;
        if (!session || typeof session.id !== "string") return undefined;
        if (ev.type === "session.created") {
          if (typeof session.title === "string") titles.set(session.id, session.title);
          if (session.parentID) knownParents.add(session.id);
          return {
            id: `v1:session.created:${session.id}:${session.time?.updated ?? 0}`,
            type: "session.created",
            location,
            data: {
              sessionID: session.id,
              parentID: session.parentID,
              title: session.title,
            },
          };
        }
        // session.updated: only forward real changes to avoid flooding the
        // process-level dedupe set with repeated identity events.
        const titleChanged =
          typeof session.title === "string" &&
          session.title !== "" &&
          session.title !== titles.get(session.id);
        const parentNow = !!(session.parentID && !knownParents.has(session.id));
        if (!titleChanged && !parentNow) return undefined;
        if (titleChanged) titles.set(session.id, session.title as string);
        if (parentNow) knownParents.add(session.id);
        return {
          id: `v1:session.created:${session.id}:u${++occurrence}`,
          type: "session.created",
          location,
          data: {
            sessionID: session.id,
            parentID: session.parentID,
            title: session.title,
          },
        };
      }

      case "session.deleted": {
        const session = (props as { info?: V1Session })?.info;
        if (!session || typeof session.id !== "string") return undefined;
        titles.delete(session.id);
        knownParents.delete(session.id);
        return {
          id: `v1:session.deleted:${session.id}:${++occurrence}`,
          type: "session.deleted",
          location,
          data: { sessionID: session.id, parentID: session.parentID },
        };
      }

      case "session.status": {
        const sessionID = props.sessionID;
        if (typeof sessionID !== "string") return undefined;
        return {
          id: `v1:activity:${sessionID}:${++occurrence}`,
          type: "session.execution.started",
          location,
          data: { sessionID },
        };
      }

      case "session.idle": {
        const sessionID = props.sessionID;
        if (typeof sessionID !== "string") return undefined;
        return {
          id: `v1:idle:${sessionID}:${++occurrence}`,
          type: "session.execution.succeeded",
          location,
          data: { sessionID },
        };
      }

      case "session.error": {
        const sessionID = props.sessionID;
        if (typeof sessionID !== "string") return undefined;
        const err = (props as { error?: V1Error }).error;
        const message = err?.data?.message ?? "";
        if (err?.name === "MessageAbortedError") {
          return {
            id: `v1:interrupted:${sessionID}:${++occurrence}`,
            type: "session.execution.interrupted",
            location,
            data: { sessionID, reason: message },
          };
        }
        return {
          id: `v1:failed:${sessionID}:${++occurrence}`,
          type: "session.execution.failed",
          location,
          data: { sessionID, error: { type: err?.name ?? "error", message } },
        };
      }

      default:
        return undefined;
    }
  };
}

/* ------------------------------ client shim ------------------------------- */

function createEventChannel(): {
  iterable: AsyncIterable<V2EventEnvelope>;
  push(envelope: V2EventEnvelope): void;
  close(): void;
} {
  // Bounded so a deferred-load failure (config error, v1 hosts have no
  // dispose chain) can never grow the queue without a consumer.
  const MAX_QUEUED = 250;
  const queue: V2EventEnvelope[] = [];
  let closed = false;
  let woken: (() => void) | undefined;
  const wake = (): void => {
    const resolve = woken;
    woken = undefined;
    resolve?.();
  };
  const push = (envelope: V2EventEnvelope): void => {
    if (closed) return;
    if (queue.length >= MAX_QUEUED) queue.shift();
    queue.push(envelope);
    wake();
  };
  const close = (): void => {
    closed = true;
    wake();
  };
  const iterable = (async function* (): AsyncIterable<V2EventEnvelope> {
    while (!closed) {
      const envelope = queue.shift();
      if (envelope) {
        yield envelope;
        continue;
      }
      await new Promise<void>((resolve) => {
        woken = resolve;
      });
    }
  })();
  return { iterable, push, close };
}

/**
 * Adapt opencode v1 input to the shared V2Client surface used by the app.
 * Returns undefined when no permission-reply surface and/or no directory is
 * available (plugin disabled). Handles both v1 permission generations:
 * legacy `postSessionIdPermissionsPermissionId` and the modern
 * `permission.reply({requestID, reply, message})` client namespace.
 */
export function createV1Core(
  input: V1PluginInput
): { client: V2Client; pushEvent(event: unknown): void } | undefined {
  const directory =
    typeof input?.directory === "string" && input.directory !== ""
      ? input.directory
      : typeof input?.worktree === "string" && input.worktree !== ""
        ? input.worktree
        : undefined;
  const sdk = input?.client as (V1SdkClient & { permission?: V1SdkPermissionReply }) | undefined;
  if (!directory || !sdk) return undefined;
  const legacyReply =
    typeof sdk.postSessionIdPermissionsPermissionId === "function"
      ? (decision: PermissionDecision, sessionID: string, permissionID: string) =>
          sdk.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID },
            query: { directory },
            body: { response: decision },
          })
      : undefined;
  const modernReply =
    sdk.permission && typeof sdk.permission.reply === "function"
      ? (decision: PermissionDecision, requestID: string) =>
          sdk.permission?.reply({ requestID, reply: decision }) ?? Promise.resolve()
      : undefined;
  if (!legacyReply && !modernReply) return undefined;

  const mapEvent = createV1EventMapper(directory);
  const { iterable, push, close } = createEventChannel();

  const client: V2Client = {
    // v1 has no per-plugin options: configuration is environment-driven
    // (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_LANGUAGE).
    options: {},
    location: { directory },
    permissionReplyField: "reply",
    event: {
      subscribe(options?: { signal?: AbortSignal } | AbortSignal) {
        const signal = options instanceof AbortSignal ? options : options?.signal;
        if (signal?.aborted) close();
        else signal?.addEventListener("abort", close, { once: true });
        return iterable;
      },
    },
    permission: {
      async reply(input) {
        if (!("decision" in input)) {
          // Legacy v1 surfaces only understand the `reply` key.
          if (modernReply) {
            await modernReply(input.reply, input.requestID);
            return;
          }
          throw new Error("legacy permission.reply called without a decision");
        }
        const decision = input.decision;
        if (legacyReply) {
          try {
            await legacyReply(decision, input.sessionID, input.requestID);
            return;
          } catch (error) {
            if (!modernReply) throw error;
            console.error(
              `[opencode-telegram-notify] legacy permission reply failed, falling back to permission.reply: ${String(error)}`
            );
          }
        }
        if (modernReply) {
          await modernReply(decision, input.requestID);
          return;
        }
      },
    },
  };

  return {
    client,
    pushEvent(event: unknown): void {
      const envelope = mapEvent(event);
      if (envelope) push(envelope);
    },
  };
}

/* -------------------------------- entry ----------------------------------- */

/** Hook surface accepted by opencode v1 plugin loading. */
export interface V1LegacyHooks {
  event(input: { event: unknown }): Promise<void>;
}

/** Default export for the `./legacy` subpath: a v1 plugin factory. */
export default function createLegacyPlugin(input: V1PluginInput): V1LegacyHooks {
  const core = createV1Core(input);
  if (!core) {
    console.log(
      "[opencode-telegram-notify] v1 host input missing client/directory or SDK surface — plugin disabled"
    );
    return { event: () => Promise.resolve() };
  }
  try {
    void createApp(core.client);
  } catch (error) {
    // Never break the host at plugin-load time (v1 hosts have no dispose
    // chain and treat factory exceptions as plugin failures).
    console.error(`[opencode-telegram-notify] v1 start failed: ${String(error)}`);
    return { event: () => Promise.resolve() };
  }
  return {
    event: async ({ event }: { event: unknown }) => {
      try {
        core.pushEvent(event);
      } catch (error) {
        console.error(`[opencode-telegram-notify] v1 event mapping failed: ${String(error)}`);
      }
    },
  };
}
