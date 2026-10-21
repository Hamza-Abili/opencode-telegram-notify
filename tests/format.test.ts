import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  formatCompleted,
  formatFailed,
  formatPermission,
  formatQuestion,
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
