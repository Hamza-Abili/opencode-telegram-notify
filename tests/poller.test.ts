import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, resetProcessUpdateDedupe, startPoller } from "../src/poller.ts";
import { mkContext } from "./helpers.ts";

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
    const stop = startPoller(ctx, { ...fast, lockDir });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(calls.commands[0]?.map((c) => c.command)).toContain("start");
    expect(fs.existsSync(path.join(lockDir, "poller.lock"))).toBe(false);
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
});
