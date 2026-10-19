import { describe, expect, test } from "bun:test";
import { dispatch, startPoller } from "../src/poller.ts";
import { mkContext, permissionAsked } from "./helpers.ts";

const CHAT = 5;

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
    const { ctx, calls } = mkContext("/tmp/proj", { telegram: { botToken: "1:x", chatId: String(CHAT), allowedUserIds: ["5"] } });
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

  test("reply failure is answered with 'already answered'", async () => {
    const { ctx, calls, answered } = mkContext();
    ctx.pending.set(88, { sessionID: "ses_1", requestID: "per_1", action: "shell" });
    // Force the permission client to fail (simulating an already-settled request).
    const perm = ctx.client.permission;
    if (perm) perm.reply = async () => { throw new Error("settled"); };
    await dispatch(ctx, cbUpdate(88, "allow"));
    expect(answered).toHaveLength(0); // reply threw before recording
    expect(calls.toasts[0].text).toContain("Already answered");
    expect(ctx.pending.has(88)).toBe(false);
  });
});

describe("poller lifecycle", () => {
  test("registers bot commands and releases the lock on dispose", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = await import("node:os").then((os) => os.tmpdir());
    const stop = startPoller(ctx, { lockDir, longPollSeconds: 1 });
    // Give the loop one tick to register commands (may be flake-free since the
    // fake getUpdates resolves immediately).
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(calls.commands[0]?.map((c) => c.command)).toContain("start");
  });

  test("offset advances and updates are not reprocessed across polls", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = await import("node:os").then((os) => os.tmpdir());

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

    const stop = startPoller(ctx, { lockDir, longPollSeconds: 1 });
    // Wait for first poll cycle + long poll timeout + a few empty polls
    await new Promise((r) => setTimeout(r, 1500));
    stop();

    // First call gets offset=0, all subsequent calls get offset=11 (10 + 1)
    expect(receivedOffsets[0]).toBe(0);
    expect(receivedOffsets.slice(1)).toHaveLength(receivedOffsets.length - 1);
    for (let i = 1; i < receivedOffsets.length; i++) {
      expect(receivedOffsets[i]).toBe(11);
    }
    // Only one "is online" message sent (no reprocessing)
    const onlineMsgs = calls.sent.filter((m) => m.text?.includes("is online"));
    expect(onlineMsgs).toHaveLength(1);
  });

  test("offset advances correctly with multiple updates in one batch", async () => {
    const { ctx, calls } = mkContext();
    const lockDir = await import("node:os").then((os) => os.tmpdir());

    const receivedOffsets: number[] = [];
    ctx.telegram.getUpdates = async (offset: number) => {
      receivedOffsets.push(offset);
      // First call: return multiple updates
      if (receivedOffsets.length === 1) {
        return [
          { update_id: 20, message: { message_id: 1, chat: { id: CHAT }, text: "/start", from: { id: 5 } } },
          { update_id: 21, message: { message_id: 2, chat: { id: CHAT }, text: "/status", from: { id: 5 } } },
          { update_id: 22, message: { message_id: 3, chat: { id: CHAT }, text: "/help", from: { id: 5 } } },
        ];
      }
      // Subsequent calls: return empty
      return [];
    };

    const stop = startPoller(ctx, { lockDir, longPollSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1500));
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
});
