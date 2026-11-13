/**
 * opencode-telegram-notify — configuration loading and validation.
 *
 * Token values support `${VAR}` expansion from the process environment so
 * secrets never have to live inside opencode.jsonc.
 */

export const LANGUAGES = ["en", "it", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

/** Non-standard but common shorthand; `cn` is a country code, not a language. */
const LANGUAGE_ALIASES = new Map<string, Language>([["cn", "zh"]]);

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Resolve a BCP-47-style language tag (`zh-CN`, `zh-Hans`, `it_IT`, `en-US`).
 * Matching is case-insensitive and falls back to the primary subtag. Unknown
 * tags use English so a config typo never disables notifications.
 */
export function parseLanguage(value: unknown): Language {
  if (typeof value !== "string") return DEFAULT_LANGUAGE;

  const tag = value.trim().toLowerCase().replace(/_/g, "-");
  if (tag === "") return DEFAULT_LANGUAGE;
  if (isLanguage(tag)) return tag;

  // Full-tag aliases first so future region aliases (e.g. zh-tw -> zh-hant)
  // can be added without changing the base-language path below.
  const exactAlias = LANGUAGE_ALIASES.get(tag);
  if (exactAlias) return exactAlias;

  const primary = tag.split("-")[0];
  if (isLanguage(primary)) return primary;
  return LANGUAGE_ALIASES.get(primary) ?? DEFAULT_LANGUAGE;
}

export interface EventsConfig {
  permission: boolean;
  question: boolean;
  idle: boolean;
  error: boolean;
  usage: boolean;
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
  /** Minimum gap between completion notifications for the same session (ms); 0 disables. */
  idleCooldownMs: number;
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
export function expandEnv(
  value: string,
  env: Record<string, string | undefined> = process.env
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
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
export function loadConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const root = (raw ?? {}) as Record<string, unknown>;
  const tg = (root.telegram ?? {}) as Record<string, unknown>;
  const events = (root.events ?? {}) as Record<string, unknown>;

  let botToken = expandEnv(String(tg.botToken ?? ""), env).trim();
  // Backwards- and configs-friendly: allow flat TELEGRAM_BOT_TOKEN env.
  if (botToken === "") botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (botToken === "") {
    throw new ConfigError(
      "options.telegram.botToken is required (use " +
        "${TELEGRAM_BOT_TOKEN} to read it from the environment)"
    );
  }
  if (!botToken.includes(":")) {
    throw new ConfigError(
      "options.telegram.botToken does not look like a Telegram token (<id>:<secret>)"
    );
  }

  const chatIdRaw =
    expandEnv(String(tg.chatId ?? ""), env).trim() || env.TELEGRAM_CHAT_ID?.trim() || "";
  if (chatIdRaw === "") {
    throw new ConfigError(
      "options.telegram.chatId is required (use " +
        "${TELEGRAM_CHAT_ID} to read it from the environment)"
    );
  }

  // A non-empty explicit string option wins even when unsupported:
  // parseLanguage falls back to English rather than silently taking a
  // different value from the env.
  const configuredLanguage =
    typeof root.language === "string" && root.language.trim() !== ""
      ? root.language
      : env.TELEGRAM_LANGUAGE;
  const language = parseLanguage(configuredLanguage);

  return {
    telegram: {
      botToken,
      chatId: chatIdRaw,
      allowedUserIds: asStringList(tg.allowedUserIds)
        .map((v) => expandEnv(v, env).trim())
        .filter((v) => v.length > 0),
    },
    language,
    events: {
      permission: asBool(events.permission, true),
      question: asBool(events.question, true),
      idle: asBool(events.idle, true),
      error: asBool(events.error, true),
      usage: asBool(events.usage, true),
    },
    interactions: asBool(root.interactions, true),
    idleDebounceMs: asNumber(root.idleDebounceMs, 60_000, 0, 600_000),
    idleCooldownMs: asNumber(root.idleCooldownMs, 600_000, 0, 3_600_000),
    maxMessageChars: asNumber(root.maxMessageChars, 3800, 500, 3900),
    hideCommands: asBool(root.hideCommands, false),
    logFile:
      typeof root.logFile === "string" && root.logFile.trim() !== ""
        ? expandEnv(root.logFile.trim(), env)
        : undefined,
  };
}
