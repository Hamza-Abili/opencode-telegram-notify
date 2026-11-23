import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, resetProcessUpdateDedupe, startPoller, tokenNamespace } from "../src/poller.ts";
import type { TelegramUpdate } from "../src/telegram.ts";
import { mkContext, waitFor } from "./helpers.ts";

const CHAT = 5;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otn-poller-"));
}

const fast = {
  longPollSeconds: 0,
  pollIntervalMs: 5,
  acquireDelayMs: 5,
  standstillMs: 5,
  failureDelayMs: 5,
};

const cbUpdate = (messageId: number, data: string, user = 5) => ({
  update_id: 1,
  callback_query: {
    id: `cb_${messageId}`,
    data,
    from: { id: user, first_name: "Owner" },
    message: { message_id: messageId, chat: { id: CHAT }, text: "🔐 Permission request" },
  },
});

const msgUpdate = (text: string, user = 5) => ({
  update_id: 2,
  message: { message_id: 3, chat: { id: CHAT }, text, from: { id: user, first_name: "Owner" } },
});

describe("dispatch — commands", () => {
  test("wrong chat is ignored", async () => {
    const { ctx, calls } = mkContext();
    await dispatch(ctx, msgUpdate("/start"));
    ctx.config.telegram.chatId = "5";
    // simulate foreign chat
    await dispatch(ctx, {
      update_id: 9,
      message: { message_id: 1, chat: { id: 999 }, text: "/start", from: { id: 5 } },
    });
    expect(calls.sent).toHaveLength(1); // only our chat answered
  });

  test("allowedUserIds gate keeps strangers out", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      telegram: { botToken: "1:x", chatId: String(CHAT), allowedUserIds: ["5"] },
    });
    await dispatch(ctx, msgUpdate("/status", 77));
    expect(calls.sent).toHaveLength(0);
    await dispatch(ctx, msgUpdate("/status", 5));
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].text).toContain("🟢");
  });

  test("/status lists active ignore rules and escapes them", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: ["autolearn review", "<b>unsafe</b>"], agents: ["reviewer"] },
    });
    await dispatch(ctx, msgUpdate("/status"));
    const text = calls.sent[0].text;
    expect(text).toContain("Ignored:");
    expect(text).toContain("autolearn review");
    expect(text).toContain("reviewer");
    expect(text).toContain("&lt;b&gt;unsafe&lt;/b&gt;");
    expect(text).not.toContain("<b>unsafe</b>");
    expect(text).toContain("Events: permission, question, idle, error, usage");
  });

  test("/status shows an empty ignore rule set and localizes it", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", { language: "it" });
    await dispatch(ctx, msgUpdate("/status"));
    const text = calls.sent[0].text;
    expect(text).toContain("Ignorati: nessuno");
  });

  test("/status truncates oversized ignore lists", async () => {
    const titles = Array.from({ length: 200 }, (_, i) => `title-${i}-${"x".repeat(20)}`);
    const { ctx, calls } = mkContext("/tmp/proj", {
      maxMessageChars: 500,
      ignore: { titles, agents: [] },
    });
    await dispatch(ctx, msgUpdate("/status"));
    expect(calls.sent[0].text.length).toBeLessThanOrEqual(500);
  });

  test("/start re-enables and echoes chat id", async () => {
    const { ctx, calls } = mkContext();
    ctx.silenced = true;
    await dispatch(ctx, msgUpdate("/start"));
    expect(ctx.silenced).toBe(false);
    expect(calls.sent[0].text).toContain("<code>5</code>");
  });

  test("/stop silences the chat", async () => {
    const { ctx, calls } = mkContext();
    await dispatch(ctx, msgUpdate("/stop"));
    expect(ctx.silenced).toBe(true);
    expect(calls.sent[0].text).toContain("🔕");
  });

  test("/setup replies with a copy-paste snippet without leaking the token", async () => {
    const { ctx, calls } = mkContext();
    await dispatch(ctx, msgUpdate("/setup"));
    const text = calls.sent[0].text;
    expect(text).toContain("opencode.jsonc");
    expect(text).toContain("${TELEGRAM_BOT_TOKEN}");
    expect(text).not.toContain("token"); // placeholder only
  });

  test("/setup localizes the env label", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", { language: "zh" });
    await dispatch(ctx, msgUpdate("/setup"));
    const text = calls.sent[0].text;
    expect(text).toContain("环境变量：");
    expect(text).not.toContain("Env vars:");
  });

  test("unknown command gets help, plain text is ignored", async () => {
    const { ctx, calls } = mkContext();
    await dispatch(ctx, msgUpdate("/frobnicate"));
    expect(calls.sent[0].text).toContain("/start");
    const before = calls.sent.length;
    await dispatch(ctx, msgUpdate("just a normal message"));
    expect(calls.sent.length).toBe(before);
  });
});

describe("dispatch — permission callbacks", () => {
  test("tap routes the decision to the permission client and closes the message", async () => {
    const { ctx, calls, answered } = mkContext();
    ctx.pending.set(77, { sessionID: "ses_1", requestID: "per_1", action: "shell" });
    await dispatch(ctx, cbUpdate(77, "allow"));
    expect(answered).toEqual([{ sessionID: "ses_1", requestID: "per_1", decision: "once" }]);
    expect(ctx.pending.has(77)).toBe(false);
    expect(calls.edits.some((e) => e.messageId === 77)).toBe(true);
    expect(calls.toasts[0]?.text).toContain("Allowed");
  });

  test("always and reject map to the right decisions", async () => {
    const { ctx, answered } = mkContext();
    ctx.pending.set(78, { sessionID: "ses_1", requestID: "per_2", action: "edit" });
    ctx.pending.set(79, { sessionID: "ses_1", requestID: "per_3", action: "edit" });
    await dispatch(ctx, cbUpdate(78, "always"));
    await dispatch(ctx, cbUpdate(79, "reject"));
    expect(answered.map((a) => a.decision)).toEqual(["always", "reject"]);
  });

  test("stale callback answers with a toast and never replies", async () => {
    const { ctx, calls, answered } = mkContext();
    await dispatch(ctx, cbUpdate(500, "allow"));
    expect(answered).toHaveLength(0);
    expect(calls.toasts).toHaveLength(1);
    expect(ctx.pending.size).toBe(0);
  });

  test("retryable reply failure keeps the button active", async () => {
    const { ctx, calls, answered } = mkContext();
    ctx.pending.set(88, { sessionID: "ses_1", requestID: "per_1", action: "shell" });
    const perm = ctx.client.permission;
    if (perm) {
      perm.reply = async () => {
        throw new Error("network down");
      };
    }
    await dispatch(ctx, cbUpdate(88, "allow"));
    expect(answered).toHaveLength(0);
    expect(calls.toasts[0].text).toContain("tap again");
    expect(calls.edits).toHaveLength(0); // message + buttons stay intact
    expect(ctx.pending.has(88)).toBe(true);
  });

  test("settled reply failure closes the button as 'already answered'", async () => {
    const { ctx, calls, answered } = mkContext();
    ctx.pending.set(89, { sessionID: "ses_1", requestID: "per_2", action: "shell" });
    const perm = ctx.client.permission;
    if (perm) {
      perm.reply = async () => {
        throw Object.assign(new Error("not found"), { status: 404 });
      };
    }
    await dispatch(ctx, cbUpdate(89, "allow"));
    expect(answered).toHaveLength(0);
    expect(calls.toasts[0].text).toContain("Already answered");
    expect(ctx.pending.has(89)).toBe(false);
  });

  test("an 'unsettled' error is not mistaken for settled", async () => {
    const { ctx, calls, answered } = mkContext();
    ctx.pending.set(92, { sessionID: "ses_1", requestID: "per_5", action: "shell" });
    const perm = ctx.client.permission;
    if (perm) {
      perm.reply = async () => {
        throw new Error("permission unsettled");
      };
    }
    await dispatch(ctx, cbUpdate(92, "allow"));
    expect(answered).toHaveLength(0);
    expect(calls.toasts[0].text).toContain("tap again");
    expect(ctx.pending.has(92)).toBe(true);
  });

  test("permission reply falls back to the legacy `reply` field and caches it", async () => {
    const { ctx, answered } = mkContext();
    let calls = 0;
    if (ctx.client.permission) {
      ctx.client.permission.reply = async (input) => {
        calls++;
        if ("decision" in input) throw new Error("unknown field decision");
        answered.push({
          sessionID: input.sessionID,
          requestID: input.requestID,
          decision: input.reply,
        });
      };
    }
    ctx.pending.set(90, { sessionID: "ses_1", requestID: "per_3", action: "shell" });
    await dispatch(ctx, cbUpdate(90, "allow"));
    ctx.pending.set(91, { sessionID: "ses_1", requestID: "per_4", action: "shell" });
    await dispatch(ctx, cbUpdate(91, "always"));
    expect(calls).toBe(3); // decision fail + reply, then cached reply only
    expect(answered.map((a) => a.decision)).toEqual(["once", "always"]);
    expect(ctx.permissionReplyField).toBe("reply");
  });
});

describe("poller lifecycle", () => {
  beforeEach(() => {
    resetProcessUpdateDedupe();
  });

  test("registers bot commands and releases the lock on dispose", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = tmpdir();
    const lockFile = path.join(lockDir, "poller.lock");
    const stop = startPoller(ctx, { ...fast, lockDir });
    await waitFor(() => fs.existsSync(lockFile), "lock acquisition");
    stop();
    await waitFor(() => !fs.existsSync(lockFile), "lock release after drain");
    expect(calls.commands[0]?.map((c) => c.command)).toContain("start");
  });

  test("a failing setMyCommands is attempted once per activation", async () => {
    const { ctx } = mkContext();
    const lockDir = tmpdir();
    let attempts = 0;
    ctx.telegram.setMyCommands = async () => {
      attempts++;
      throw new Error("commands down");
    };
    const stop = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(attempts).toBe(1);
  });

  test("offset advances and updates are not reprocessed across polls", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = tmpdir();
    const receivedOffsets: number[] = [];
    // Override getUpdates to capture offsets and return updates sequentially
    ctx.telegram.getUpdates = async (offset: number) => {
      receivedOffsets.push(offset);
      // First call: return one /start command
      if (receivedOffsets.length === 1) {
        return [
          {
            update_id: 10,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
        ];
      }
      // Subsequent calls: return empty (simulates no new updates)
      return [];
    };

    const stop = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 120));
    stop();

    // First call gets offset=0, all subsequent calls get offset=11 (10 + 1)
    expect(receivedOffsets[0]).toBe(0);
    for (let i = 1; i < receivedOffsets.length; i++) {
      expect(receivedOffsets[i]).toBe(11);
    }
    // Only one "is online" message sent (no reprocessing)
    const onlineMsgs = calls.sent.filter((m) => m.text?.includes("is online"));
    expect(onlineMsgs).toHaveLength(1);
  });

  test("offset advances correctly with multiple updates in one batch", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = tmpdir();
    const receivedOffsets: number[] = [];
    ctx.telegram.getUpdates = async (offset: number) => {
      receivedOffsets.push(offset);
      // First call: return multiple updates
      if (receivedOffsets.length === 1) {
        return [
          {
            update_id: 20,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
          {
            update_id: 21,
            message: { message_id: 2, chat: { id: CHAT }, text: "/status", from: { id: 5 } },
          },
          {
            update_id: 22,
            message: { message_id: 3, chat: { id: CHAT }, text: "/help", from: { id: 5 } },
          },
        ];
      }
      // Subsequent calls: return empty
      return [];
    };

    const stop = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 120));
    stop();

    // First call gets offset=0, all subsequent calls get offset=23 (22 + 1)
    expect(receivedOffsets[0]).toBe(0);
    for (let i = 1; i < receivedOffsets.length; i++) {
      expect(receivedOffsets[i]).toBe(23);
    }
    // Three commands processed, one "is online" from /start
    const onlineMsgs = calls.sent.filter((m) => m.text?.includes("is online"));
    expect(onlineMsgs).toHaveLength(1);
  });

  test("offset persists across poller restarts", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = tmpdir();
    const receivedOffsets: number[] = [];
    let callCount = 0;
    ctx.telegram.getUpdates = async (offset: number) => {
      receivedOffsets.push(offset);
      callCount++;
      if (callCount === 1) {
        return [
          {
            update_id: 30,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
        ];
      }
      if (callCount === 2) {
        // Second poller instance should start from persisted offset (31)
        return [];
      }
      return [];
    };

    // First poller run
    const stop1 = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 60));
    stop1();

    // Second poller run (simulating restart)
    const stop2 = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 60));
    stop2();

    // First call gets offset=0, second poller starts from offset=31
    expect(receivedOffsets[0]).toBe(0);
    expect(receivedOffsets[1]).toBe(31);
    // Only one "is online" message sent total
    const onlineMsgs = calls.sent.filter((m) => m.text?.includes("is online"));
    expect(onlineMsgs).toHaveLength(1);
  });

  test("dedupe prevents reprocessing same update_id in same process", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = tmpdir();
    const receivedOffsets: number[] = [];
    let callCount = 0;
    ctx.telegram.getUpdates = async (offset: number) => {
      receivedOffsets.push(offset);
      callCount++;
      if (callCount === 1) {
        return [
          {
            update_id: 40,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
        ];
      }
      if (callCount === 2) {
        // Simulate Telegram redelivering the same update
        return [
          {
            update_id: 40,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
        ];
      }
      return [];
    };

    const stop = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 100));
    stop();

    // Should only process the update once despite redelivery
    const onlineMsgs = calls.sent.filter((m) => m.text?.includes("is online"));
    expect(onlineMsgs).toHaveLength(1);
  });

  test("dispose aborts an in-flight long poll instead of waiting for the cycle", async () => {
    const { ctx } = mkContext();
    const lockDir = tmpdir();
    let calls = 0;
    let captured: AbortSignal | undefined;
    ctx.telegram.getUpdates = (_offset: number, _lp: number, signal?: AbortSignal) => {
      calls++;
      captured = signal;
      return new Promise<TelegramUpdate[]>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const stop = startPoller(ctx, { ...fast, lockDir });
    await waitFor(() => calls === 1, "long poll entered");
    expect(captured?.aborted).toBe(false); // the poller passed its signal through
    stop();
    await waitFor(() => captured?.aborted === true, "long-poll abort");
    await new Promise((r) => setTimeout(r, 30));
    const settled = calls;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(settled); // the loop stopped polling
    expect(ctx.interactive).toBe(false);
  });

  test("dispose drains the in-flight dispatch before releasing the lock", async () => {
    const { ctx } = mkContext();
    const lockDir = tmpdir();
    const lockFile = path.join(lockDir, "poller.lock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const originalSend = ctx.telegram.sendMessage.bind(ctx.telegram);
    ctx.telegram.sendMessage = async (text, options) => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return originalSend(text, options);
    };
    let first = true;
    ctx.telegram.getUpdates = async () => {
      if (!first) return [];
      first = false;
      return [
        {
          update_id: 80,
          message: { message_id: 1, chat: { id: CHAT }, text: "/stop", from: { id: 5 } },
        },
      ];
    };

    const stop = startPoller(ctx, { ...fast, lockDir });
    await waitFor(() => entered, "in-flight /stop send");
    stop();
    // The update was not committed yet: releasing the lock here would let a
    // standby read stale state and overwrite the /stop silence.
    expect(fs.existsSync(lockFile)).toBe(true);
    release();
    await waitFor(() => !fs.existsSync(lockFile), "drained lock release");

    const state = JSON.parse(fs.readFileSync(path.join(lockDir, "poller.offset.json"), "utf8"));
    expect(state).toEqual({ offset: 81, silenced: true });
  });
});

describe("poller state and namespacing", () => {
  beforeEach(() => {
    resetProcessUpdateDedupe();
  });

  test("the default lock dir is namespaced per bot token", async () => {
    const { ctx } = mkContext();
    const xdg = tmpdir();
    const namespace = tokenNamespace(ctx.config.telegram.botToken);
    const scoped = path.join(xdg, "opencode-telegram-notify", namespace);
    const base = path.join(xdg, "opencode-telegram-notify");
    let first = true;
    ctx.telegram.getUpdates = async () => {
      if (!first) return [];
      first = false;
      return [
        {
          update_id: 3,
          message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
        },
      ];
    };
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdg;
    let stop: (() => void) | undefined;
    try {
      stop = startPoller(ctx, { ...fast });
      await waitFor(
        () => fs.existsSync(path.join(scoped, "poller.offset.json")),
        "namespaced state file"
      );
      expect(fs.existsSync(path.join(scoped, "poller.lock"))).toBe(true);
      expect(fs.existsSync(path.join(base, "poller.offset.json"))).toBe(false);
      expect(fs.existsSync(path.join(base, "poller.lock"))).toBe(false);
    } finally {
      stop?.();
      process.env.XDG_CACHE_HOME = previous;
    }
    await waitFor(() => !fs.existsSync(path.join(scoped, "poller.lock")), "lock release");
  });

  test("an explicit lockDir is used as-is (no namespacing)", async () => {
    const { ctx } = mkContext();
    const lockDir = tmpdir();
    let first = true;
    ctx.telegram.getUpdates = async () => {
      if (!first) return [];
      first = false;
      return [
        {
          update_id: 4,
          message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
        },
      ];
    };
    const stop = startPoller(ctx, { ...fast, lockDir });
    await waitFor(
      () => fs.existsSync(path.join(lockDir, "poller.offset.json")),
      "state file in explicit lockDir"
    );
    expect(fs.existsSync(path.join(lockDir, "poller.lock"))).toBe(true);
    expect(fs.readdirSync(lockDir).some((e) => /^[0-9a-f]{16}$/.test(e))).toBe(false);
    stop();
    await waitFor(() => !fs.existsSync(path.join(lockDir, "poller.lock")), "lock release");
  });

  test("different bot tokens use different namespaces and can poll together", async () => {
    const xdg = tmpdir();
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdg;
    const { ctx: a } = mkContext("/tmp/a", {
      telegram: { botToken: "1:aaa", chatId: String(CHAT), allowedUserIds: [] },
    });
    const { ctx: b } = mkContext("/tmp/b", {
      telegram: { botToken: "2:bbb", chatId: String(CHAT), allowedUserIds: [] },
    });
    let aPolls = 0;
    let bPolls = 0;
    a.telegram.getUpdates = async () => {
      aPolls++;
      return [];
    };
    b.telegram.getUpdates = async () => {
      bPolls++;
      return [];
    };
    const dirA = path.join(xdg, "opencode-telegram-notify", tokenNamespace("1:aaa"));
    const dirB = path.join(xdg, "opencode-telegram-notify", tokenNamespace("2:bbb"));
    let stopA: (() => void) | undefined;
    let stopB: (() => void) | undefined;
    try {
      expect(dirA).not.toBe(dirB);
      stopA = startPoller(a, { ...fast });
      stopB = startPoller(b, { ...fast });
      await waitFor(
        () =>
          aPolls > 0 &&
          bPolls > 0 &&
          fs.existsSync(path.join(dirA, "poller.lock")) &&
          fs.existsSync(path.join(dirB, "poller.lock")),
        "both per-token pollers"
      );
      expect(aPolls).toBeGreaterThan(0);
      expect(bPolls).toBeGreaterThan(0);
    } finally {
      stopA?.();
      stopB?.();
      process.env.XDG_CACHE_HOME = previous;
    }
    await waitFor(
      () =>
        !fs.existsSync(path.join(dirA, "poller.lock")) &&
        !fs.existsSync(path.join(dirB, "poller.lock")),
      "both locks released"
    );
  });

  test("a persisted /stop is restored on the next activation", async () => {
    const { ctx } = mkContext();
    const lockDir = tmpdir();
    let first = true;
    ctx.telegram.getUpdates = async (offset: number) => {
      if (!first || offset !== 0) return [];
      first = false;
      return [
        {
          update_id: 50,
          message: { message_id: 1, chat: { id: CHAT }, text: "/stop", from: { id: 5 } },
        },
      ];
    };
    const stop1 = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 60));
    stop1();
    expect(ctx.silenced).toBe(true);

    const { ctx: ctx2 } = mkContext();
    const stop2 = startPoller(ctx2, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx2.silenced).toBe(true);
    stop2();
  });

  test("standby instances mirror a /stop persisted by the live owner", async () => {
    const { ctx: ctxA } = mkContext();
    const lockDir = tmpdir();
    ctxA.telegram.getUpdates = async () => [];
    const stopA = startPoller(ctxA, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 40)); // A owns the lock

    let bPolls = 0;
    const { ctx: ctxB } = mkContext();
    ctxB.telegram.getUpdates = async () => {
      bPolls++;
      return [];
    };
    const stopB = startPoller(ctxB, { ...fast, lockDir, acquireDelayMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(bPolls).toBe(0); // standby: never polls

    // The owner persists a silence (as it would after /stop); B picks it up
    // on its next standby cycle without ever owning the lock.
    ctxA.silenced = true;
    fs.writeFileSync(
      path.join(lockDir, "poller.offset.json"),
      JSON.stringify({ offset: 5, silenced: true })
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(ctxB.silenced).toBe(true);

    stopB();
    stopA();
  });

  test("a dedupe hit still advances the persisted offset (no livelock)", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = tmpdir();
    const firstOffsets: number[] = [];
    ctx.telegram.getUpdates = async (offset: number) => {
      firstOffsets.push(offset);
      if (firstOffsets.length === 1) {
        return [
          {
            update_id: 70,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
        ];
      }
      return [];
    };
    const stop1 = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 80));
    stop1();
    // Simulate a crash that lost the state write: the process-level dedupe
    // still remembers update 70, so the next activation receives it at 0.
    fs.rmSync(path.join(lockDir, "poller.offset.json"));

    const secondOffsets: number[] = [];
    ctx.telegram.getUpdates = async (offset: number) => {
      secondOffsets.push(offset);
      if (secondOffsets.length === 1) {
        return [
          {
            update_id: 70,
            message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } },
          },
        ];
      }
      return [];
    };
    const stop2 = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 80));
    stop2();

    expect(secondOffsets[0]).toBe(0);
    expect(secondOffsets.slice(1).every((o) => o === 71)).toBe(true);
    expect(secondOffsets.length).toBeGreaterThan(1);
    const state = JSON.parse(fs.readFileSync(path.join(lockDir, "poller.offset.json"), "utf8"));
    expect(state.offset).toBe(71);
    const onlineMsgs = calls.sent.filter((m) => m.text?.includes("is online"));
    expect(onlineMsgs).toHaveLength(1); // the deduped redelivery was not re-sent
  });

  test("the pre-0.7.1 shared offset file is ignored, not misattributed", async () => {
    const { ctx } = mkContext();
    const xdg = tmpdir();
    const base = path.join(xdg, "opencode-telegram-notify");
    fs.mkdirSync(base, { recursive: true });
    const legacy = path.join(base, "poller.offset.json");
    fs.writeFileSync(legacy, JSON.stringify({ offset: 777 }));
    const offsets: number[] = [];
    ctx.telegram.getUpdates = async (offset: number) => {
      offsets.push(offset);
      return [];
    };
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdg;
    try {
      const stop = startPoller(ctx, { ...fast });
      await new Promise((r) => setTimeout(r, 40));
      stop();
    } finally {
      process.env.XDG_CACHE_HOME = previous;
    }
    // A legacy file carries no token identity; inheriting it could silently
    // swallow another bot's updates, so upgrades start at 0 instead.
    expect(offsets[0]).toBe(0);
    expect(fs.readFileSync(legacy, "utf8")).toContain("777");
  });

  test("warns once when a group chat has no allowedUserIds", async () => {
    const logs: string[] = [];
    const { ctx } = mkContext("/tmp/proj", {
      telegram: { botToken: "1:x", chatId: "-100123456", allowedUserIds: [] },
    });
    ctx.log = (m) => logs.push(m);
    const stop = startPoller(ctx, { ...fast, lockDir: tmpdir() });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(logs.some((l) => l.includes("allowedUserIds"))).toBe(true);
    expect(logs.filter((l) => l.includes("allowedUserIds"))).toHaveLength(1);
  });

  test("stays quiet when the group chat has an allowlist", async () => {
    const logs: string[] = [];
    const { ctx } = mkContext("/tmp/proj", {
      telegram: { botToken: "1:x", chatId: "-100123456", allowedUserIds: ["5"] },
    });
    ctx.log = (m) => logs.push(m);
    const stop = startPoller(ctx, { ...fast, lockDir: tmpdir() });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(logs.some((l) => l.includes("allowedUserIds"))).toBe(false);
  });
});
