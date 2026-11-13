/**
 * opencode-telegram-notify — message catalogs and translation helper.
 *
 * English is the canonical catalog; every locale must define exactly its keys.
 * `t()` is a static lookup with `{placeholder}` interpolation. Catalogs are
 * complete by type and tests, so there is no runtime fallback machinery.
 */

import type { Language } from "../config.ts";
import type { PermissionDecision } from "../types.ts";
import { type Catalog, en, type MessageKey } from "./en.ts";
import { it } from "./it.ts";
import { zh } from "./zh.ts";

export type { Catalog, MessageKey } from "./en.ts";

export const CATALOGS: Record<Language, Catalog> = { en, it, zh };

/** Every catalog key, in canonical English order. */
export const MESSAGE_KEYS = Object.keys(en) as MessageKey[];

/** Translate one message key and interpolate `{name}` placeholders. */
export function t(lang: Language, key: MessageKey, vars: Record<string, string> = {}): string {
  let out = CATALOGS[lang][key];
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/** Human label of a decision inside confirmation lines. */
export function decisionLabel(lang: Language, decision: PermissionDecision): string {
  const key: MessageKey =
    decision === "reject"
      ? "decisionReject"
      : decision === "always"
        ? "decisionAlways"
        : "decisionOnce";
  return t(lang, key);
}
