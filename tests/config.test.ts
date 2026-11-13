import { describe, expect, test } from "bun:test";
import { ConfigError, expandEnv, loadConfig, parseLanguage } from "../src/config.ts";

describe("parseLanguage", () => {
  test("matches base language and normalizes BCP-47-style tags", () => {
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("EN-us")).toBe("en");
    expect(parseLanguage("it-IT")).toBe("it");
    expect(parseLanguage("it_IT")).toBe("it");
    expect(parseLanguage("zh")).toBe("zh");
    expect(parseLanguage("ZH_cn")).toBe("zh");
    expect(parseLanguage("zh-Hans")).toBe("zh");
    expect(parseLanguage("zh-Hans-CN")).toBe("zh");
    expect(parseLanguage("zh-TW")).toBe("zh");
    expect(parseLanguage("zh-Hant")).toBe("zh");
    expect(parseLanguage("cn")).toBe("zh");
  });

  test("unknown or malformed tags fall back to en", () => {
    expect(parseLanguage("fr")).toBe("en");
    expect(parseLanguage("")).toBe("en");
    expect(parseLanguage("   ")).toBe("en");
    expect(parseLanguage(undefined)).toBe("en");
    expect(parseLanguage(null)).toBe("en");
    expect(parseLanguage(42)).toBe("en");
    expect(parseLanguage("constructor")).toBe("en");
    expect(parseLanguage("__proto__")).toBe("en");
    expect(parseLanguage("toString")).toBe("en");
  });
});

describe("expandEnv", () => {
  test("expands ${VAR} references", () => {
    const env = { TELEGRAM_TEST_TOKEN: "abc:def", EMPTY: "" };
    expect(expandEnv("${TELEGRAM_TEST_TOKEN}", env)).toBe("abc:def");
    expect(expandEnv("${MISSING_VAR}", env)).toBe("");
    expect(expandEnv("no refs", env)).toBe("no refs");
  });
});

describe("loadConfig", () => {
  const base = {
    telegram: { botToken: "${T}", chatId: "${C}" },
  };

  test("resolves env expansion and defaults", () => {
    const cfg = loadConfig(base, { T: "1:token", C: "42" });
    expect(cfg.telegram.botToken).toBe("1:token");
    expect(cfg.telegram.chatId).toBe("42");
    expect(cfg.language).toBe("en");
    expect(cfg.events.permission).toBe(true);
    expect(cfg.interactions).toBe(true);
    expect(cfg.idleDebounceMs).toBe(60_000);
  });

  test("flat env fallback works", () => {
    const cfg = loadConfig({}, { TELEGRAM_BOT_TOKEN: "2:tok", TELEGRAM_CHAT_ID: "+7" });
    expect(cfg.telegram.botToken).toBe("2:tok");
    expect(cfg.telegram.chatId).toBe("+7");
  });

  test("masks: missing token fails", () => {
    expect(() => loadConfig({ telegram: { chatId: "1" } }, {})).toThrow(ConfigError);
  });

  test("missing chat id fails", () => {
    expect(() => loadConfig({ telegram: { botToken: "a:b" } }, {})).toThrow(ConfigError);
  });

  test("malformed token fails", () => {
    expect(() => loadConfig({ telegram: { botToken: "nocolon", chatId: "1" } }, {})).toThrow(
      ConfigError
    );
  });

  test("allowedUserIds accepts list or comma string", () => {
    const a = loadConfig(
      { ...base, telegram: { ...base.telegram, allowedUserIds: ["1", "2"] } },
      { T: "1:x", C: "1" }
    );
    const b = loadConfig(
      { ...base, telegram: { ...base.telegram, allowedUserIds: "3,4" } },
      { T: "1:x", C: "1" }
    );
    expect(a.telegram.allowedUserIds).toEqual(["1", "2"]);
    expect(b.telegram.allowedUserIds).toEqual(["3", "4"]);
  });

  test("language accepts tags and falls back to en", () => {
    const it = loadConfig({ ...base, language: "it-IT" }, { T: "1:x", C: "1" });
    expect(it.language).toBe("it");
    const zh = loadConfig({ ...base, language: "zh-CN" }, { T: "1:x", C: "1" });
    expect(zh.language).toBe("zh");
    const defaulted = loadConfig({ ...base, language: "fr" }, { T: "1:x", C: "1" });
    expect(defaulted.language).toBe("en");
  });

  test("language option wins over TELEGRAM_LANGUAGE", () => {
    const cfg = loadConfig(
      { ...base, language: "zh-Hans" },
      { T: "1:x", C: "1", TELEGRAM_LANGUAGE: "it" }
    );
    expect(cfg.language).toBe("zh");
    const invalid = loadConfig(
      { ...base, language: "fr" },
      { T: "1:x", C: "1", TELEGRAM_LANGUAGE: "it" }
    );
    expect(invalid.language).toBe("en");
  });

  test("TELEGRAM_LANGUAGE is parsed when options omit language", () => {
    const cfg = loadConfig(
      {},
      {
        TELEGRAM_BOT_TOKEN: "1:x",
        TELEGRAM_CHAT_ID: "1",
        TELEGRAM_LANGUAGE: "zh-CN",
      }
    );
    expect(cfg.language).toBe("zh");
  });

  test("numeric clamps stay within range", () => {
    const cfg = loadConfig({ ...base, idleDebounceMs: 9_999_999 }, { T: "1:x", C: "1" });
    expect(cfg.idleDebounceMs).toBe(600_000);
    const clamped = loadConfig({ ...base, idleCooldownMs: 5_000_000 }, { T: "1:x", C: "1" });
    expect(clamped.idleCooldownMs).toBe(3_600_000);
    const neutral = loadConfig({ ...base, idleCooldownMs: -1 }, { T: "1:x", C: "1" });
    expect(neutral.idleCooldownMs).toBe(0);
  });

  test("numeric parsing rejects partial strings instead of silently parsing a prefix", () => {
    const cfg = loadConfig({ ...base, idleDebounceMs: "15s" }, { T: "1:x", C: "1" });
    expect(cfg.idleDebounceMs).toBe(60_000);
    const stringy = loadConfig({ ...base, idleDebounceMs: "1500" }, { T: "1:x", C: "1" });
    expect(stringy.idleDebounceMs).toBe(1500);
  });

  test("empty expanded allowlist entries are discarded", () => {
    const cfg = loadConfig(
      { ...base, telegram: { ...base.telegram, allowedUserIds: ["${MISSING}", " 7 "] } },
      { T: "1:x", C: "1" }
    );
    expect(cfg.telegram.allowedUserIds).toEqual(["7"]);
  });

  test("events flags parse booleans", () => {
    const cfg = loadConfig(
      { ...base, events: { permission: "false", idle: true } },
      { T: "1:x", C: "1" }
    );
    expect(cfg.events.permission).toBe(false);
    expect(cfg.events.idle).toBe(true);
    expect(cfg.events.question).toBe(true);
  });
});
