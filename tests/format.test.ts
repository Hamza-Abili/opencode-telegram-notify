import { describe, expect, test } from "bun:test";
import {
  compactTokens,
  escapeHtml,
  formatCompleted,
  formatCost,
  formatFailed,
  formatPermission,
  formatQuestion,
  formatUsage,
  truncate,
  truncateHtml,
} from "../src/format.ts";
import {
  ANSWER_IN_TERMINAL,
  ANSWER_WITH_BUTTONS,
  PERMISSION_ANSWER_IN_TERMINAL,
} from "../src/i18n.ts";

const ctx = {
  language: "en" as const,
  hideCommands: false,
  maxBody: 3800,
  project: "my-app",
  sessionTitle: (id: string) => (id === "ses_1" ? "Fix login" : undefined),
};

describe("escapeHtml / truncate", () => {
  test("escapes html specials", () => {
    expect(escapeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
  test("truncates with ellipsis", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(truncate("ab", 5)).toBe("ab");
  });

  test("truncateHtml never cuts a tag or entity and closes open tags", () => {
    const value = `<b>${escapeHtml("a & b < c")}</b> and <code>tail</code>`;
    const cut = truncateHtml(value, 20);
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut).toContain("&amp;");
    expect(cut.endsWith("</b>")).toBe(true);
    expect(cut).not.toContain("<co");
  });
});

describe("formatPermission", () => {
  test("renders action and resources with session title", () => {
    const msg = formatPermission(
      { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["ls -la", "git status"] },
      ctx
    );
    expect(msg).toContain("<b>🔐 Permission request</b>");
    expect(msg).toContain("Project: my-app");
    expect(msg).toContain("Session: Fix login");
    expect(msg).toContain("<b>shell</b>");
    expect(msg).toContain("<code>ls -la</code>");
  });

  test("hideCommands replaces resources with count", () => {
    const msg = formatPermission(
      { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["secret cmd"] },
      { ...ctx, hideCommands: true }
    );
    expect(msg).not.toContain("secret cmd");
    expect(msg).toContain("[1]");
  });

  test("+N indicator beyond 3 items", () => {
    const msg = formatPermission(
      { id: "per_1", sessionID: "ses_x", action: "shell", resources: ["1", "2", "3", "4"] },
      ctx
    );
    expect(msg).toContain("+1");
  });

  test("plain mode tells the user to answer in the terminal", () => {
    const msg = formatPermission(
      { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["ls"] },
      ctx,
      "plain"
    );
    expect(msg).toContain(PERMISSION_ANSWER_IN_TERMINAL.en);
  });
});

describe("formatQuestion", () => {
  test("renders title, fields, options and terminal notice", () => {
    const msg = formatQuestion(
      {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Deploy?",
          fields: [
            {
              key: "q0",
              title: "Which env?",
              type: "string",
              options: [
                { value: "stg", label: "Staging" },
                { value: "prd", label: "Production" },
              ],
            },
          ],
        },
      },
      ctx
    );
    expect(msg).toContain("<b>❓ Question</b>");
    expect(msg).toContain("Deploy?");
    expect(msg).toContain("Which env?");
    expect(msg).toContain("• Production");
    expect(msg).toContain(ANSWER_IN_TERMINAL.en);
  });

  test("buttons mode swaps the terminal pointer for the tap pointer", () => {
    const msg = formatQuestion(
      {
        form: {
          id: "frm_2",
          sessionID: "ses_1",
          title: "Deploy?",
          fields: [],
        },
      },
      ctx,
      "buttons"
    );
    expect(msg).toContain(ANSWER_WITH_BUTTONS.en);
    expect(msg).not.toContain(ANSWER_IN_TERMINAL.en);
  });
});

describe("lifecycle", () => {
  test("completed shows project and session title exactly once", () => {
    const msg = formatCompleted("ses_1", ctx);
    expect(msg).toContain("✅ Task completed");
    expect(msg).toContain("Project: my-app");
    expect(msg).toContain("Session: Fix login");
    expect(msg.match(/Fix login/g)).toHaveLength(1);
  });
  test("failed includes error type and message", () => {
    const msg = formatFailed({ type: "provider.no-route", message: "Model unavailable" }, ctx);
    expect(msg).toContain("❌ Task failed");
    expect(msg).toContain("<code>provider.no-route</code>");
    expect(msg).toContain("Model unavailable");
  });
});

describe("usage formatting", () => {
  test("compactTokens renders k/M and small numbers", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(12800)).toBe("12.8k");
    expect(compactTokens(3_200_000)).toBe("3.2M");
    expect(compactTokens(0)).toBe("0");
  });

  test("formatCost trims trailing zeros to 4 decimals", () => {
    expect(formatCost(0.042)).toBe("0.042");
    expect(formatCost(1.5)).toBe("1.5");
    expect(formatCost(0)).toBe("0");
  });

  test("formatUsage summarizes input/output/cost with cache and reasoning folded in", () => {
    const line = formatUsage(
      { input: 12800, output: 3000, reasoning: 200, cache: { read: 400, write: 0 } },
      0.042,
      "en"
    );
    expect(line).toContain("13.2k in");
    expect(line).toContain("3.2k out");
    expect(line).toContain("$0.042");
  });

  test("formatUsage returns undefined when everything is zero or missing", () => {
    expect(formatUsage(undefined, undefined, "en")).toBeUndefined();
    expect(
      formatUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0, "en")
    ).toBeUndefined();
  });

  test("formatUsage renders a cost-only line when tokens are absent", () => {
    expect(formatUsage(undefined, 0.042, "en")).toBe("⚡ $0.042");
  });

  test("formatCompleted appends the usage line and omits it when absent", () => {
    const withUsage = formatCompleted("ses_1", ctx, {
      cost: 0.042,
      tokens: { input: 12800, output: 3200, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(withUsage).toContain("$0.042");
    const without = formatCompleted("ses_1", ctx);
    expect(without).not.toContain("⚡");
  });
});

describe("failure limit labels", () => {
  test("provider.free-limit gets a friendly headline instead of the raw type", () => {
    const msg = formatFailed(
      { type: "provider.free-limit", message: "Free usage limit reached." },
      ctx
    );
    expect(msg).toContain("Free usage limit reached");
    expect(msg).not.toContain("provider.free-limit");
  });

  test("quota, rate-limit and budget types map to their labels", () => {
    expect(formatFailed({ type: "provider.quota" }, ctx)).toContain("Provider quota reached");
    expect(formatFailed({ type: "provider.rate-limit" }, ctx)).toContain("Rate limit reached");
    expect(formatFailed({ type: "provider.budget-limit" }, ctx)).toContain(
      "Workspace budget reached"
    );
    expect(formatFailed({ type: "provider.model-budget-limit" }, ctx)).toContain(
      "Model budget reached"
    );
  });

  test("unknown error types keep the raw code", () => {
    const msg = formatFailed({ type: "provider.no-route", message: "Model unavailable" }, ctx);
    expect(msg).toContain("<code>provider.no-route</code>");
    expect(msg).toContain("Model unavailable");
  });

  test("Italian labels render when language is it", () => {
    const itCtx = { ...ctx, language: "it" as const };
    expect(formatFailed({ type: "provider.free-limit" }, itCtx)).toContain(
      "Limite utilizzo gratuito raggiunto"
    );
  });
});
