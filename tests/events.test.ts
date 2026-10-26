import { beforeEach, describe, expect, test } from "bun:test";
import { createRouter, resetProcessEventDedupe } from "../src/events.ts";
import { env, mkContext, permissionAsked } from "./helpers.ts";

describe("router", () => {
  beforeEach(() => {
    resetProcessEventDedupe();
  });

  test("permission.asked sends with buttons and registers pending", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].text).toContain("shell");
    const buttons = calls.sent[0].buttons as { callback_data: string }[][];
    expect(buttons.flat().map((b) => b.callback_data)).toEqual(["allow", "reject", "always"]);
    expect(ctx.pending.size).toBe(1);
    expect(ctx.permMsgs.get("per_1")).toBe(901);
  });

  test("interactions=false sends without buttons and points to the terminal", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", { interactions: false });
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].buttons).toBeUndefined();
    expect(calls.sent[0].text).toContain("⌨️");
  });

  test("a standby instance sends notify-only permission messages", async () => {
    const { ctx, calls } = mkContext();
    ctx.interactive = false;
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    expect(calls.sent[0].buttons).toBeUndefined();
    expect(ctx.pending.size).toBe(0);
  });

  test("the same permission id is never notified twice", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    await router.handle(env("e2", "permission.asked", permissionAsked("per_1")));
    expect(calls.sent).toHaveLength(1);
  });

  test("duplicate event ids are processed once", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    expect(calls.sent).toHaveLength(1);
  });

  test("foreign root location is ignored", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1"), "/elsewhere"));
    expect(calls.sent).toHaveLength(0);
  });

  test("no-location events use the attribution index", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("a", "session.created", { sessionID: "ses_9", title: "T" }));
    await router.handle({
      id: "b",
      type: "session.execution.failed",
      data: { sessionID: "ses_9", error: { type: "x", message: "boom" } },
    });
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].text).toContain("❌ Task failed");
  });

  test("permission.replied closes message and clears pending", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    const msgId = ctx.permMsgs.get("per_1") as number;
    await router.handle({
      id: "e2",
      type: "permission.replied",
      data: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
    });
    expect(ctx.pending.has(msgId)).toBe(false);
    expect(ctx.permMsgs.has("per_1")).toBe(false);
    expect(calls.edits.some((e) => e.messageId === msgId && e.text.includes("always"))).toBe(true);
  });

  test("form.created notifies, form.replied closes", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(
      env("f1", "form.created", {
        form: { id: "frm_1", sessionID: "ses_1", title: "Deploy?", fields: [] },
      })
    );
    expect(calls.sent[0].text).toContain("Deploy?");
    await router.handle({
      id: "f2",
      type: "form.replied",
      data: { id: "frm_1", sessionID: "ses_1" },
    });
    expect(calls.edits[0].text).toContain("Answered");
  });

  test("form.cancelled closes with cancelled label", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(
      env("f1", "form.created", {
        form: { id: "frm_2", sessionID: "ses_1", title: "Deploy?", fields: [] },
      })
    );
    await router.handle({
      id: "f2",
      type: "form.cancelled",
      data: { id: "frm_2", sessionID: "ses_1" },
    });
    expect(calls.edits[0].text).toContain("Cancelled");
  });

  test("idle debounce fires completed only after silence", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("x1", "session.created", { sessionID: "ses_2", title: "Pipeline" }));
    await router.handle(env("x2", "session.execution.succeeded", { sessionID: "ses_2" }));
    await new Promise((r) => setTimeout(r, 40));
    const completed = calls.sent.find((s) => s.text.includes("✅ Task completed"));
    expect(completed).toBeDefined();
    expect(completed?.text).toContain("Pipeline");
  });

  test("activity cancels idle notification", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("x1", "session.created", { sessionID: "ses_2", title: "Pipeline" }));
    await router.handle(env("x2", "session.execution.succeeded", { sessionID: "ses_2" }));
    await router.handle(
      env("x3", "session.step.started", { sessionID: "ses_2", assistantMessageID: "m" })
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
  });

  test("completion notifications respect the per-session cooldown", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", { idleCooldownMs: 5_000 });
    const router = createRouter(ctx);
    // First idle cycle fires (cooldown had elapsed at startup).
    await router.handle(env("c1", "session.execution.succeeded", { sessionID: "ses_9" }));
    await new Promise((r) => setTimeout(r, 30));
    const first = calls.sent.filter((s) => s.text.includes("✅ Task completed"));
    expect(first).toHaveLength(1);
    // Second cycle within the cooldown window is silently suppressed.
    await router.handle(env("c2", "session.step.started", { sessionID: "ses_9" }));
    await router.handle(env("c3", "session.execution.succeeded", { sessionID: "ses_9" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent.filter((s) => s.text.includes("✅ Task completed"))).toHaveLength(1);
  });

  test("completion resolves the title via session.get when the cache is empty", async () => {
    const { ctx, calls } = mkContext();
    ctx.client.session = {
      async get() {
        return { id: "ses_77", title: "Fetched Title" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("t1", "session.execution.succeeded", { sessionID: "ses_77" }));
    await new Promise((r) => setTimeout(r, 40));
    const completed = calls.sent.find((s) => s.text.includes("✅ Task completed"));
    expect(completed?.text).toContain("Fetched Title");
    expect(ctx.sessionTitles.get("ses_77")).toBe("Fetched Title");
  });

  test("completion includes the usage line when session.get reports cost and tokens", async () => {
    const { ctx, calls } = mkContext();
    ctx.client.session = {
      async get() {
        return {
          id: "ses_u",
          title: "Usage Session",
          cost: 0.042,
          tokens: {
            input: 12800,
            output: 3200,
            reasoning: 0,
            cache: { read: 400, write: 100 },
          },
        };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("u1", "session.execution.succeeded", { sessionID: "ses_u" }));
    await new Promise((r) => setTimeout(r, 40));
    const completed = calls.sent.find((s) => s.text.includes("✅ Task completed"));
    expect(completed?.text).toContain("⚡");
    expect(completed?.text).toContain("13.3k in");
    expect(completed?.text).toContain("3.2k out");
    expect(completed?.text).toContain("$0.042");
  });

  test("events.usage=false omits the usage line but keeps the title", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      events: { permission: true, question: true, idle: true, error: true, usage: false },
    });
    ctx.client.session = {
      async get() {
        return {
          id: "ses_u2",
          title: "Usage Session",
          cost: 0.042,
          tokens: { input: 12800, output: 3200, reasoning: 0, cache: { read: 0, write: 0 } },
        };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("u2", "session.execution.succeeded", { sessionID: "ses_u2" }));
    await new Promise((r) => setTimeout(r, 40));
    const completed = calls.sent.find((s) => s.text.includes("✅ Task completed"));
    expect(completed?.text).toContain("Usage Session");
    expect(completed?.text).not.toContain("⚡");
  });

  test("completion omits the usage line when the session surface reports nothing", async () => {
    const { ctx, calls } = mkContext();
    ctx.client.session = {
      async get() {
        return { id: "ses_u3", title: "No Usage" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("u3", "session.execution.succeeded", { sessionID: "ses_u3" }));
    await new Promise((r) => setTimeout(r, 40));
    const completed = calls.sent.find((s) => s.text.includes("✅ Task completed"));
    expect(completed?.text).toContain("No Usage");
    expect(completed?.text).not.toContain("⚡");
  });

  test("completion falls back to the project name when no title exists", async () => {
    const { ctx, calls } = mkContext();
    // fakeClient exposes no session surface and nothing cached the title.
    const router = createRouter(ctx);
    await router.handle(env("t2", "session.execution.succeeded", { sessionID: "ses_42" }));
    await new Promise((r) => setTimeout(r, 40));
    const completed = calls.sent.find((s) => s.text.includes("✅ Task completed"));
    expect(completed?.text).toContain("proj");
    expect(completed?.text).not.toContain("(no details)");
  });

  test("session.deleted clears title, attribution and pending button state", async () => {
    const { ctx } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("c1", "session.created", { sessionID: "ses_d", title: "Gone" }));
    await router.handle(env("p1", "permission.asked", permissionAsked("per_d", "ses_d")));
    const messageId = ctx.permMsgs.get("per_d") as number;
    expect(ctx.pending.has(messageId)).toBe(true);
    await router.handle({ id: "d1", type: "session.deleted", data: { sessionID: "ses_d" } });
    expect(ctx.sessionTitles.has("ses_d")).toBe(false);
    expect(ctx.sessionDirs.has("ses_d")).toBe(false);
    expect(ctx.pending.has(messageId)).toBe(false);
  });

  test("child sessions never send lifecycle notifications", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(
      env("c1", "session.created", { sessionID: "ses_c", parentID: "ses_p", title: "sub" })
    );
    await router.handle(env("c2", "session.execution.succeeded", { sessionID: "ses_c" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
  });

  test("silenced chat suppresses notifications", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    ctx.silenced = true;
    await router.handle(env("e9", "permission.asked", permissionAsked("per_9")));
    await router.handle(env("e10", "session.execution.failed", { sessionID: "ses_1", error: {} }));
    expect(calls.sent).toHaveLength(0);
  });

  test("dispose clears pending idle timers", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("x2", "session.execution.succeeded", { sessionID: "ses_2" }));
    router.dispose();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
  });
});
