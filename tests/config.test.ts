import { describe, expect, test } from "bun:test";
import { ConfigError, expandEnv, loadConfig } from "../src/config.ts";

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
    expect(cfg.idleDebounceMs).toBe(15_000);
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
    expect(() => loadConfig({ telegram: { botToken: "nocolon", chatId: "1" } }, {})).toThrow(ConfigError);
  });

  test("allowedUserIds accepts list or comma string", () => {
    const a = loadConfig({ ...base, telegram: { ...base.telegram, allowedUserIds: ["1", "2"] } }, { T: "1:x", C: "1" });
    const b = loadConfig({ ...base, telegram: { ...base.telegram, allowedUserIds: "3,4" } }, { T: "1:x", C: "1" });
    expect(a.telegram.allowedUserIds).toEqual(["1", "2"]);
    expect(b.telegram.allowedUserIds).toEqual(["3", "4"]);
  });

  test("language it accepted, others fall back to en", () => {
    const it = loadConfig({ ...base, language: "it" }, { T: "1:x", C: "1" });
    expect(it.language).toBe("it");
    const defaulted = loadConfig({ ...base, language: "fr" }, { T: "1:x", C: "1" });
    expect(defaulted.language).toBe("en");
  });

  test("numeric clamps stay within range", () => {
    const cfg = loadConfig({ ...base, idleDebounceMs: 9_999_999 }, { T: "1:x", C: "1" });
    expect(cfg.idleDebounceMs).toBe(600_000);
  });

  test("events flags parse booleans", () => {
    const cfg = loadConfig({ ...base, events: { permission: "false", idle: true } }, { T: "1:x", C: "1" });
    expect(cfg.events.permission).toBe(false);
    expect(cfg.events.idle).toBe(true);
    expect(cfg.events.question).toBe(true);
  });
});
