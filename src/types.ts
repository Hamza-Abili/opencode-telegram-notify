/**
 * opencode-telegram-notify — local V2 client types.
 *
 * These interfaces mirror the observed opencode v2 plugin client surface
 * (`{id, setup}` activation, event envelopes, permission client).
 * They are intentionally local: the plugin has zero runtime dependencies.
 */

/** Authorization decision for a pending permission request. */
export type PermissionDecision = "once" | "always" | "reject";

/** Minimal session info returned by `client.session.get`. */
export interface V2SessionInfo {
  id: string;
  title?: string;
  slug?: string;
  projectID?: string;
  parentID?: string;
  directory?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

/** Event envelope as delivered by `client.event.subscribe()`. */
export interface V2EventEnvelope {
  id: string;
  type: string;
  created?: number;
  durable?: unknown;
  location?: { directory?: string };
  data?: unknown;
}

/* --------------------------------- events -------------------------------- */

/** data payload of `permission.asked`. */
export interface PermissionAskedData {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  source?: { type: string; messageID?: string; id?: string };
}

/** data payload of `permission.replied`. */
export interface PermissionRepliedData {
  sessionID: string;
  requestID: string;
  reply: PermissionDecision;
}

export type FormFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "multiselect"
  | "external";

export interface FormFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormField {
  key: string;
  title: string;
  type: FormFieldType;
  options?: FormFieldOption[];
  custom?: boolean;
  required?: boolean;
}

/** data payload of `form.created` (opencode v2 question flow). */
export interface FormCreatedData {
  form: {
    id: string;
    sessionID: string;
    title: string;
    metadata?: { kind?: string; tool?: { messageID?: string; id?: string } };
    fields: FormField[];
  };
}

/** data payload of `form.replied`. */
export interface FormRepliedData {
  id: string;
  sessionID: string;
  answer?: Record<string, unknown>;
}

/** data payload of `form.cancelled`. */
export interface FormCancelledData {
  id: string;
  sessionID: string;
}

/** data payload of `session.deleted`. */
export interface SessionDeletedData {
  sessionID: string;
  parentID?: string;
}

/** data payload of `session.execution.*`. */
export interface ExecutionData {
  sessionID: string;
  error?: { type?: string; message?: string };
  reason?: string;
}

/** data payload of `session.step.started` / `session.tool.*`. */
export interface StepStartedData {
  sessionID: string;
  assistantMessageID: string;
  agent?: string;
}

/** data payload of `session.created`. */
export interface SessionCreatedData {
  sessionID: string;
  parentID?: string;
  title?: string;
  slug?: string;
  agent?: string;
}

/* --------------------------------- client -------------------------------- */

export type PermissionReplyField = "decision" | "reply";

export interface PermissionReplyDecision {
  sessionID: string;
  requestID: string;
  decision: PermissionDecision;
  message?: string;
}

export interface PermissionReplyCompat {
  sessionID: string;
  requestID: string;
  reply: PermissionDecision;
  message?: string;
}

/** Answer payload accepted by the internal form surface. */
export type FormAnswer = Record<string, string | string[]>;

/**
 * The subset of the opencode v2 plugin client this plugin uses.
 * Everything is optional so configuration errors degrade gracefully.
 */
export interface V2Client {
  app?: { name?: string; version?: string; channel?: string };
  /** Per-plugin options from opencode.jsonc (`plugins: [{package, options}]`). */
  options?: Record<string, unknown>;
  location?: {
    directory: string;
    workspaceID?: unknown;
    project?: { id?: string; canonical?: string };
  };
  event?: {
    subscribe(options?: { signal?: AbortSignal } | AbortSignal): AsyncIterable<V2EventEnvelope>;
  };
  permission?: {
    reply(input: PermissionReplyDecision | PermissionReplyCompat): Promise<void>;
  };
  /**
   * Internal hint used by the v1 adapter: which key its permission surface
   * expects. Undefined means "probe `decision`, then `reply`".
   */
  permissionReplyField?: PermissionReplyField;
  session?: {
    get(input: { sessionID: string }): Promise<V2SessionInfo>;
    /** Newer hosts expose the form API under `session.form`. */
    form?: {
      reply(input: { sessionID: string; formID: string; answer: FormAnswer }): Promise<unknown>;
    };
    /** Some v2 builds expose question answering under `session.question`. */
    question?: LooseQuestion;
  };
  /** Question (form) surface of the opencode v2 SDK (global namespace). */
  question?: LooseQuestion;
}

/** Loose typing for the question fallback surfaces of the v2 SDK. */
export interface LooseQuestion {
  reply?: (input: {
    requestID: string;
    answers?: string[][];
    sessionID?: string;
    questionV2Reply?: { answers: string[][] };
  }) => Promise<unknown>;
  reject?: (input: { requestID: string; sessionID?: string }) => Promise<unknown>;
  list?: (input: { directory: string }) => Promise<unknown>;
}

/** Plugin activation signature per opencode v2 `{id, setup}` contract. */
export type V2Setup = (client: V2Client | Promise<V2Client>) => (() => void) | undefined;

export interface V2PluginDefinition {
  id: string;
  setup: V2Setup;
}
