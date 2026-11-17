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

  test("permission.asked renders Chinese labels when language is zh", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", { language: "zh" });
    const router = createRouter(ctx);
    await router.handle(env("e1", "permission.asked", permissionAsked("per_1")));
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].text).toContain("🔐 权限请求");
    const buttons = calls.sent[0].buttons as { text: string }[][];
    expect(buttons.flat().map((b) => b.text)).toEqual(["仅允许一次", "拒绝", "始终允许"]);
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

describe("ignored sessions", () => {
  beforeEach(() => {
    resetProcessEventDedupe();
  });

  test("a title match silences permissions, completions and failures", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: ["autolearn review"], agents: [] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("i1", "session.created", {
        sessionID: "ses_bg",
        title: "autolearn review",
        agent: "build",
      })
    );
    await router.handle(env("i2", "permission.asked", permissionAsked("per_i", "ses_bg")));
    await router.handle(env("i3", "session.execution.succeeded", { sessionID: "ses_bg" }));
    await router.handle(
      env("i4", "session.execution.failed", { sessionID: "ses_bg", error: { type: "x" } })
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
    expect(ctx.pending.size).toBe(0);
  });

  test("titles match as case-insensitive substrings", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: ["AUTOLEARN"], agents: [] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("i5", "session.created", { sessionID: "ses_bg", title: "autolearn review #2" })
    );
    await router.handle(env("i6", "session.execution.succeeded", { sessionID: "ses_bg" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
  });

  test("an agent match silences a session whose title is unrelated", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("i7", "session.created", {
        sessionID: "ses_bg",
        title: "Weekly digest",
        agent: "autolearn-reviewer",
      })
    );
    await router.handle(env("i8", "session.execution.succeeded", { sessionID: "ses_bg" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
  });

  test("other sessions keep notifying while an ignore rule is active", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: ["autolearn review"], agents: ["autolearn-reviewer"] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("i9", "session.created", { sessionID: "ses_ok", title: "Fix login", agent: "build" })
    );
    await router.handle(env("i10", "permission.asked", permissionAsked("per_ok", "ses_ok")));
    await router.handle(env("i11", "session.execution.succeeded", { sessionID: "ses_ok" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent.filter((s) => s.text.includes("🔐"))).toHaveLength(1);
    expect(calls.sent.filter((s) => s.text.includes("✅ Task completed"))).toHaveLength(1);
  });

  test("a session started before the plugin reload is resolved via session.get", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    let lookups = 0;
    ctx.client.session = {
      async get() {
        lookups += 1;
        return { id: "ses_old", title: "Nightly sweep", agent: "autolearn-reviewer" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("i12", "session.execution.succeeded", { sessionID: "ses_old" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(lookups).toBe(1);
    expect(calls.sent).toHaveLength(0);
  });

  test("a rename into an ignored title cancels a pending completion", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: ["autolearn review"], agents: [] },
      idleDebounceMs: 60,
    });
    const router = createRouter(ctx);
    await router.handle(env("i13", "session.created", { sessionID: "ses_r", title: "Fresh run" }));
    await router.handle(env("i14", "session.execution.succeeded", { sessionID: "ses_r" }));
    await router.handle(
      env("i15", "session.renamed", { sessionID: "ses_r", title: "autolearn review" })
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.sent).toHaveLength(0);
  });

  test("an agent switch into an ignore rule silences the rest of the session", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("a1", "session.created", { sessionID: "ses_a", title: "Weekly digest", agent: "build" })
    );
    await router.handle(
      env("a2", "session.agent.selected", {
        sessionID: "ses_a",
        agent: "autolearn-reviewer",
        previous: "build",
      })
    );
    await router.handle(env("a3", "session.execution.succeeded", { sessionID: "ses_a" }));
    await router.handle(env("a4", "permission.asked", permissionAsked("per_a", "ses_a")));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent).toHaveLength(0);
  });

  test("an agent switch out of an ignore rule un-mutes the session", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("b1", "session.created", {
        sessionID: "ses_b",
        title: "Digest",
        agent: "autolearn-reviewer",
      })
    );
    await router.handle(env("b2", "session.execution.succeeded", { sessionID: "ses_b" }));
    await router.handle(
      env("b3", "session.agent.selected", {
        sessionID: "ses_b",
        agent: "build",
        previous: "autolearn-reviewer",
      })
    );
    await router.handle(env("b4", "session.execution.succeeded", { sessionID: "ses_b" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent.filter((s) => s.text.includes("✅ Task completed"))).toHaveLength(1);
  });

  test("an agent switch inside the debounce window cancels a pending completion", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
      idleDebounceMs: 60,
    });
    const router = createRouter(ctx);
    await router.handle(
      env("c1", "session.created", { sessionID: "ses_sw", title: "Digest", agent: "build" })
    );
    await router.handle(env("c2", "session.execution.succeeded", { sessionID: "ses_sw" }));
    await router.handle(
      env("c3", "session.agent.selected", { sessionID: "ses_sw", agent: "autolearn-reviewer" })
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.sent).toHaveLength(0);
  });

  test("a host that reports no agent is looked up once, not on every event", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    let lookups = 0;
    ctx.client.session = {
      async get() {
        lookups += 1;
        return { id: "ses_n", title: "Interactive" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("n1", "permission.asked", permissionAsked("per_n1", "ses_n")));
    await router.handle(env("n2", "permission.asked", permissionAsked("per_n2", "ses_n")));
    await router.handle(
      env("n3", "session.execution.failed", { sessionID: "ses_n", error: { type: "x" } })
    );
    expect(lookups).toBe(1);
    expect(calls.sent.filter((s) => s.text.includes("🔐"))).toHaveLength(2);
    expect(calls.sent.filter((s) => s.text.includes("❌"))).toHaveLength(1);
  });

  test("a mute lookup that reports no agent keeps notifying", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    ctx.client.session = {
      async get() {
        return { id: "ses_nf", title: "Interactive" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("m1", "session.execution.succeeded", { sessionID: "ses_nf" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.sent.filter((s) => s.text.includes("✅ Task completed"))).toHaveLength(1);
  });

  test("a muted question and a muted cancellation send nothing", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: ["autolearn review"], agents: [] },
    });
    const router = createRouter(ctx);
    await router.handle(
      env("q1", "session.created", { sessionID: "ses_q", title: "autolearn review" })
    );
    await router.handle(
      env("q2", "form.created", {
        form: { id: "frm_q", sessionID: "ses_q", title: "Deploy?", fields: [] },
      })
    );
    await router.handle(env("q3", "session.execution.interrupted", { sessionID: "ses_q" }));
    expect(calls.sent).toHaveLength(0);
    expect(ctx.formMsgs.size).toBe(0);
  });

  test("/stop during a mute lookup still suppresses the notification", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.client.session = {
      async get() {
        await gate;
        return { id: "ses_stop", title: "T", agent: "build" };
      },
    };
    const router = createRouter(ctx);
    const pending = router.handle(
      env("s1", "permission.asked", permissionAsked("per_stop", "ses_stop"))
    );
    ctx.silenced = true;
    release();
    await pending;
    expect(calls.sent).toHaveLength(0);
  });

  test("a failure cancels a completion still inside its debounce window", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      events: { permission: true, question: true, idle: true, error: false, usage: true },
      idleDebounceMs: 60,
    });
    const router = createRouter(ctx);
    await router.handle(env("f1", "session.created", { sessionID: "ses_f", title: "Run" }));
    await router.handle(env("f2", "session.execution.succeeded", { sessionID: "ses_f" }));
    await router.handle(
      env("f3", "session.execution.failed", { sessionID: "ses_f", error: { type: "x" } })
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.sent).toHaveLength(0);
  });

  test("an agent switch during the completion lookup suppresses the message", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", {
      ignore: { titles: [], agents: ["autolearn-reviewer"] },
      idleDebounceMs: 20,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.client.session = {
      async get() {
        await gate;
        return { id: "ses_g", title: "Digest", agent: "build" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(
      env("g1", "session.created", { sessionID: "ses_g", title: "Digest", agent: "build" })
    );
    await router.handle(env("g2", "session.execution.succeeded", { sessionID: "ses_g" }));
    await new Promise((r) => setTimeout(r, 30)); // timer is inside session.get
    await router.handle(
      env("g3", "session.agent.selected", { sessionID: "ses_g", agent: "autolearn-reviewer" })
    );
    release();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.sent).toHaveLength(0);
  });

  test("a run that starts while a completion lookup is in flight is not duplicated", async () => {
    const { ctx, calls } = mkContext("/tmp/proj", { idleDebounceMs: 20 });
    let lookups = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.client.session = {
      async get() {
        lookups += 1;
        if (lookups === 1) await gate;
        return { id: "ses_dup", title: "Debounced" };
      },
    };
    const router = createRouter(ctx);
    await router.handle(env("u1", "session.execution.succeeded", { sessionID: "ses_dup" }));
    await new Promise((r) => setTimeout(r, 30)); // first timer is inside session.get
    await router.handle(env("u2", "session.execution.succeeded", { sessionID: "ses_dup" }));
    release();
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.sent.filter((s) => s.text.includes("✅ Task completed"))).toHaveLength(1);
  });
});
