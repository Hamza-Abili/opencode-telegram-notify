/**
 * opencode-telegram-notify — i18n strings (English / Italian).
 * Values may contain {placeholders}; formatting is via `tr()`.
 */

import type { Language } from "./config.ts";
import type { PermissionDecision } from "./types.ts";

/** Simple {name} interpolation. */
export function tr(
  lang: Language,
  strings: Record<Language, string>,
  vars: Record<string, string> = {}
): string {
  let out = strings[lang] ?? strings.en;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/** Human label of a decision inside confirmation lines. */
export function decisionLabel(lang: Language, decision: PermissionDecision): string {
  if (decision === "reject") return lang === "it" ? "rifiutato" : "rejected";
  if (decision === "always") return lang === "it" ? "sempre" : "always";
  return lang === "it" ? "una volta" : "once";
}

export const TITLE = {
  en: "OpenCode needs you",
  it: "OpenCode ha bisogno di te",
} as const;

export const PERMISSION = {
  en: "🔐 Permission request",
  it: "🔐 Richiesta di permesso",
} as const;

export const QUESTION = {
  en: "❓ Question",
  it: "❓ Domanda",
} as const;

export const COMPLETED = {
  en: "✅ Task completed",
  it: "✅ Task completato",
} as const;

export const FAILED = {
  en: "❌ Task failed",
  it: "❌ Task fallito",
} as const;

export const CANCELLED = {
  en: "⏹ Task cancelled",
  it: "⏹ Task annullato",
} as const;

export const ERROR = {
  en: "💥 Session error",
  it: "💥 Errore di sessione",
} as const;

export const PROJECT = {
  en: "Project",
  it: "Progetto",
} as const;

export const SESSION = {
  en: "Session",
  it: "Sessione",
} as const;

export const ANSWER_ONCE = {
  en: "Allow once",
  it: "Consenti una volta",
} as const;

export const ANSWER_ALWAYS = {
  en: "Always allow",
  it: "Consenti sempre",
} as const;

export const ANSWER_REJECT = {
  en: "Reject",
  it: "Rifiuta",
} as const;

export const DONE_ALLOWED = {
  en: "✅ Allowed ({decision})",
  it: "✅ Consentito ({decision})",
} as const;

export const DONE_REJECTED = {
  en: "🚫 Rejected",
  it: "🚫 Rifiutato",
} as const;

export const ANSWERED_IN_TERMINAL = {
  en: "Already answered (terminal)",
  it: "Già risposto (terminale)",
} as const;

export const EXPIRED_OR_STALE = {
  en: "Outdated or answered elsewhere",
  it: "Scaduto o già risposto altrove",
} as const;

export const ANSWER_IN_TERMINAL = {
  en: "⌨️ Answer in your terminal — tap-only bot cannot answer questions for you.",
  it: "⌨️ Rispondi nel terminale — il bot non risponde alle domande per te.",
} as const;

export const START = {
  en: [
    "🤖 <b>opencode-telegram-notify</b> is online.",
    "Chat ID: <code>{chatId}</code>",
    "You will get notifications for permission requests, questions and task lifecycle.",
    "Permission buttons are tap-only: nothing is ever auto-approved.",
  ].join("\n"),
  it: [
    "🤖 <b>opencode-telegram-notify</b> è online.",
    "Chat ID: <code>{chatId}</code>",
    "Riceverai notifiche per permessi, domande e ciclo di vita dei task.",
    "I bottoni dei permessi sono tap-only: nessuna approvazione automatica.",
  ].join("\n"),
} as const;

export const HELP = {
  en: [
    "Commands:",
    "/start — connection info + chat id",
    "/status — plugin status",
    "/setup — copy-paste ready config",
    "/stop — silence this chat",
    "Unknown commands and plain messages are ignored.",
  ].join("\n"),
  it: [
    "Comandi:",
    "/start — info di connessione + chat id",
    "/status — stato del plugin",
    "/setup — config pronta da copiare",
    "/stop — silenzia questa chat",
    "Comandi sconosciuti e messaggi normali vengono ignorati.",
  ].join("\n"),
} as const;

export const SHUTTING_DONE = {
  en: "🔕 Chat silenced. Press /start to re-enable.",
  it: "🔕 Chat silenziata. Premi /start per riattivare.",
} as const;

export const STATUS_ONLINE = {
  en: "🟢 Plugin running",
  it: "🟢 Plugin attivo",
} as const;

export const EMPTY = {
  en: "(no details)",
  it: "(nessun dettaglio)",
} as const;
