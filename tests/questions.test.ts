import { beforeEach, describe, expect, test } from "bun:test";
import { createRouter, resetProcessEventDedupe } from "../src/events.ts";
import { dispatch, resetProcessUpdateDedupe } from "../src/poller.ts";
import type { FormCreatedData } from "../src/types.ts";
import { env, fakeClient, mkContext } from "./helpers.ts";

const CHAT = 5;

const singleSelectForm = (id = "frm_1"): FormCreatedData => ({
  form: {
    id,
    sessionID: "ses_1",
    title: "Deploy?",
    fields: [
      {
        key: "env",
        title: "Environment",
        type: "multiselect",
        options: [
          { value: "staging", label: "Alpha (staging)" },
          { value: "prod", label: "Beta (prod)" },
        ],
      },
    ],
  },
});

const cbUpdate = (messageId: number, data: string) => ({
  update_id: 1,
  callback_query: {
    id: `cb_${messageId}`,
    data,
    from: { id: 5, first_name: "Owner" },
    message: { message_id: messageId, chat: { id: CHAT }, text: "❓ Question" },
  },
});

describe("questions — notify", () => {
  beforeEach(() => {
    resetProcessEventDedupe();
    resetProcessUpdateDedupe();
  });

  test("single-select form sends tap buttons and registers the pending form", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("f1", "form.created", singleSelectForm()));
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].text).toContain("👆");
    const buttons = calls.sent[0].buttons as { callback_data: string }[][];
    expect(buttons.flat().map((b) => b.callback_data)).toEqual(["q:0", "q:1", "qskip"]);
    expect(ctx.pendingForms.size).toBe(1);
    expect(ctx.formMsgs.get("frm_1")).toBe(901);
  });

  test("multi-field form stays notify-only with the terminal pointer", async () => {
    const { ctx, calls } = mkContext();
    const form = singleSelectForm();
    form.form.fields = [...form.form.fields, { key: "notes", title: "Notes", type: "string" }];
    const router = createRouter(ctx);
    await router.handle(env("f1", "form.created", form));
    expect(calls.sent[0].buttons).toBeUndefined();
    expect(calls.sent[0].text).toContain("⌨️");
    expect(ctx.pendingForms.size).toBe(0);
  });

  test("repeated form.created for the same id does not duplicate", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("f1", "form.created", singleSelectForm()));
    await router.handle(env("f2", "form.created", singleSelectForm()));
    expect(calls.sent).toHaveLength(1);
  });

  test("form.replied closes the message and clears the pending form", async () => {
    const { ctx, calls } = mkContext();
    const router = createRouter(ctx);
    await router.handle(env("f1", "form.created", singleSelectForm()));
    await router.handle({
      id: "f2",
      type: "form.replied",
      data: { id: "frm_1", sessionID: "ses_1" },
    });
    expect(calls.edits.some((e) => e.messageId === 901 && e.text.includes("✅"))).toBe(true);
    expect(ctx.formMsgs.size).toBe(0);
    expect(ctx.pendingForms.size).toBe(0);
  });

  test("restart recovery re-notifies pending questions from question.list without duplicates", async () => {
    const { ctx, calls } = mkContext();
    const client = fakeClient("/tmp/proj");
    if (client.question) {
      client.question.list = async () => [singleSelectForm("frm_pending").form];
    }
    ctx.client = client;
    const router = createRouter(ctx);
    await new Promise((resolve_) => setTimeout(resolve_, 10)); // recovery is fire-and-forget
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].buttons).toBeDefined();
    // The later stream event for the same form must not duplicate.
    await router.handle(env("f9", "form.created", singleSelectForm("frm_pending")));
    expect(calls.sent).toHaveLength(1);
  });
});

describe("questions — taps", () => {
  beforeEach(() => {
    resetProcessEventDedupe();
    resetProcessUpdateDedupe();
  });

  function withPendingForm(): ReturnType<typeof mkContext> {
    const built = mkContext();
    built.ctx.pendingForms.set(901, {
      formID: "frm_1",
      sessionID: "ses_1",
      fieldKey: "env",
      options: [
        { value: "staging", label: "Alpha (staging)" },
        { value: "prod", label: "Beta (prod)" },
      ],
    });
    return built;
  }

  test("tap q:1 answers with the selected label and closes the message", async () => {
    const { ctx, calls, questionAnswers } = withPendingForm();
    await dispatch(ctx, cbUpdate(901, "q:1"));
    expect(questionAnswers).toEqual([{ requestID: "frm_1", answers: [["Beta (prod)"]] }]);
    expect(calls.edits.some((e) => e.messageId === 901 && e.text.includes("✅"))).toBe(true);
    expect(calls.toasts.some((t) => t.text.includes("✅"))).toBe(true);
    expect(ctx.pendingForms.size).toBe(0);
  });

  test("official session.form.reply receives the field key and machine value", async () => {
    const built = withPendingForm();
    const { ctx, calls } = built;
    const replies: unknown[] = [];
    ctx.client.session = {
      async get() {
        return { id: "ses_1" };
      },
      form: {
        async reply(input) {
          replies.push(input);
        },
      },
    };
    await dispatch(ctx, cbUpdate(901, "q:1"));
    expect(replies).toEqual([{ sessionID: "ses_1", formID: "frm_1", answer: { env: ["prod"] } }]);
    expect(calls.edits.some((e) => e.text.includes("✅"))).toBe(true);
    expect(ctx.pendingForms.size).toBe(0);
  });

  test("a transient question failure keeps the pending button active", async () => {
    const built = withPendingForm();
    const { ctx, calls } = built;
    if (ctx.client.question) {
      ctx.client.question.reply = async () => {
        throw new Error("network down");
      };
    }
    await dispatch(ctx, cbUpdate(901, "q:0"));
    expect(calls.toasts.some((t) => t.text.includes("tap again"))).toBe(true);
    expect(ctx.pendingForms.has(901)).toBe(true);
  });

  test("tap qskip rejects through question.reject", async () => {
    const { ctx, calls, questionRejects, questionAnswers } = withPendingForm();
    await dispatch(ctx, cbUpdate(901, "qskip"));
    expect(questionRejects).toEqual([{ requestID: "frm_1" }]);
    expect(questionAnswers).toHaveLength(0);
    expect(calls.edits.some((e) => e.messageId === 901 && e.text.includes("⏹"))).toBe(true);
    expect(ctx.pendingForms.size).toBe(0);
  });

  test("stale question tap answers nowhere and marks the message stale", async () => {
    const { ctx, calls, questionAnswers } = mkContext();
    await dispatch(ctx, cbUpdate(901, "q:1"));
    expect(questionAnswers).toHaveLength(0);
    expect(calls.toasts.some((t) => t.text.includes("Outdated"))).toBe(true);
    expect(calls.edits.some((e) => e.text.includes("Outdated"))).toBe(true);
  });

  test("unknown tap index falls back to the stale path without replying", async () => {
    const { ctx, calls, questionAnswers } = withPendingForm();
    await dispatch(ctx, cbUpdate(901, "q:9"));
    expect(questionAnswers).toHaveLength(0);
    expect(calls.toasts.some((t) => t.text.includes("Outdated"))).toBe(true);
  });

  test("settled question (reply throws) marks 'answered elsewhere'", async () => {
    const built = withPendingForm();
    const { ctx, calls } = built;
    if (ctx.client.question) {
      ctx.client.question.reply = async () => {
        throw new Error("settled");
      };
    }
    await dispatch(ctx, cbUpdate(901, "q:0"));
    expect(calls.toasts.some((t) => t.text.includes("terminal"))).toBe(true);
    expect(ctx.pendingForms.size).toBe(0);
  });
});
