import { describe, expect, test } from "bun:test";
import { LANGUAGES } from "../src/config.ts";
import { CATALOGS, decisionLabel, MESSAGE_KEYS, t } from "../src/i18n/index.ts";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-z][a-z0-9]*)\}/gi)].map((m) => m[1] ?? "").sort();
}

function tags(value: string): string[] {
  return [...value.matchAll(/<\/?([a-z][a-z0-9]*)[^>]*>/gi)]
    .map((m) => (m[0].startsWith("</") ? "/" : "") + (m[1] ?? "").toLowerCase())
    .sort();
}

describe("message catalogs", () => {
  test("every language defines every key with a non-empty value", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...LANGUAGES].sort());
    for (const lang of LANGUAGES) {
      expect(Object.keys(CATALOGS[lang]).sort()).toEqual([...MESSAGE_KEYS].sort());
      for (const key of MESSAGE_KEYS) {
        expect(CATALOGS[lang][key].trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("every translation preserves the English placeholders", () => {
    for (const lang of LANGUAGES) {
      for (const key of MESSAGE_KEYS) {
        expect(placeholders(CATALOGS[lang][key])).toEqual(placeholders(CATALOGS.en[key]));
      }
    }
  });

  test("every translation preserves the English HTML tags", () => {
    for (const lang of LANGUAGES) {
      for (const key of MESSAGE_KEYS) {
        expect(tags(CATALOGS[lang][key])).toEqual(tags(CATALOGS.en[key]));
      }
    }
  });

  test("t interpolates placeholders", () => {
    expect(t("zh", "start", { chatId: "42" })).toContain("<code>42</code>");
    expect(t("it", "doneAllowed", { decision: "sempre" })).toBe("✅ Consentito (sempre)");
  });

  test("decisionLabel covers every decision and language", () => {
    expect(decisionLabel("en", "once")).toBe("once");
    expect(decisionLabel("it", "always")).toBe("sempre");
    expect(decisionLabel("zh", "reject")).toBe("拒绝");
    expect(decisionLabel("zh", "once")).toBe("一次");
  });
});
