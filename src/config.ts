/**
 * opencode-telegram-notify — configuration loading and validation.
 *
 * Token values support `${VAR}` expansion from the process environment so
 * secrets never have to live inside opencode.jsonc.
 */

export type Language = "en" | "it";

export interface EventsConfig {
  permission: boolean;
  question: boolean;
  idle: boolean;
  error: boolean;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  allowedUserIds: string[];
}

export interface AppConfig {
  telegram: TelegramConfig;
  language: Language;
  events: EventsConfig;
  /** Allow inline tap buttons (permissions). Notification-only when false. */
  interactions: boolean;
  /** Debounce window before an idle/completion notification fires (ms). */
  idleDebounceMs: number;
  /** Time-to-live for duplicate notification suppression (ms). */
  dedupTtlMs: number;
  /** Maximum characters of a formatted message body. */
  maxMessageChars: number;
  /** Hide command/tool args from notification bodies (privacy). */
  hideCommands: boolean;
  /** Optional append-only debug log file path. */
  logFile?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Resolve `${VAR}` references inside a string against the environment. */
export function expandEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  return fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

/**
 * Validate and normalize raw plugin options into an AppConfig.
 * Throws ConfigError with a precise message when required values are missing.
 *
 * OpenCode v1 has no per-plugin options, so the flat environment variables
 * `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `TELEGRAM_LANGUAGE` act as
 * fallbacks for the corresponding values.
 */
export function loadConfig(raw: unknown, env: Record<string, string | undefined> = process.env): AppConfig {
  const root = (raw ?? {}) as Record<string, unknown>;
  const tg = (root.telegram ?? {}) as Record<string, unknown>;
  const events = (root.events ?? {}) as Record<string, unknown>;

  let botToken = expandEnv(String(tg.botToken ?? ""), env).trim();
  // Backwards- and configs-friendly: allow flat TELEGRAM_BOT_TOKEN env.
  if (botToken === "") botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (botToken === "") {
    throw new ConfigError(
      'options.telegram.botToken is required (use "${TELEGRAM_BOT_TOKEN}" to read it from the environment)'
    );
  }
  if (!botToken.includes(":")) {
    throw new ConfigError("options.telegram.botToken does not look like a Telegram token (<id>:<secret>)");
  }

  const chatIdRaw = expandEnv(String(tg.chatId ?? ""), env).trim() || env.TELEGRAM_CHAT_ID?.trim() || "";
  if (chatIdRaw === "") {
    throw new ConfigError(
      'options.telegram.chatId is required (use "${TELEGRAM_CHAT_ID}" to read it from the environment)'
    );
  }

  const language =
    root.language === "it" || (!root.language && env.TELEGRAM_LANGUAGE?.trim() === "it") ? "it" : "en";

  return {
    telegram: {
      botToken,
      chatId: chatIdRaw,
      allowedUserIds: asStringList(tg.allowedUserIds).map((v) => expandEnv(v, env).trim()),
    },
    language,
    events: {
      permission: asBool(events.permission, true),
      question: asBool(events.question, true),
      idle: asBool(events.idle, true),
      error: asBool(events.error, true),
    },
    interactions: asBool(root.interactions, true),
    idleDebounceMs: asNumber(root.idleDebounceMs, 15_000, 0, 600_000),
    dedupTtlMs: asNumber(root.dedupTtlMs, 120_000, 0, 900_000),
    maxMessageChars: asNumber(root.maxMessageChars, 3800, 500, 3900),
    hideCommands: asBool(root.hideCommands, false),
    logFile:
      typeof root.logFile === "string" && root.logFile.trim() !== ""
        ? expandEnv(root.logFile.trim(), env)
        : undefined,
  };
}
