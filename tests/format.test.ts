import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  formatCompleted,
  formatFailed,
  formatPermission,
  formatQuestion,
  truncate,
} from "../src/format.ts";
import { ANSWER_IN_TERMINAL } from "../src/i18n.ts";

const ctx = {
  language: "en" as const,
  hideCommands: false,
  maxBody: 3800,
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
});

describe("formatPermission", () => {
  test("renders action and resources with session title", () => {
    const msg = formatPermission(
      { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["ls -la", "git status"] },
      ctx
    );
    expect(msg).toContain("<b>🔐 Permission request</b>");
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
});

describe("lifecycle", () => {
  test("completed with title", () => {
    const msg = formatCompleted("ses_1", "Fix login", ctx);
    expect(msg).toContain("✅ Task completed");
    expect(msg).toContain("Fix login");
  });
  test("failed includes error type and message", () => {
    const msg = formatFailed({ type: "provider.no-route", message: "Model unavailable" }, ctx);
    expect(msg).toContain("❌ Task failed");
    expect(msg).toContain("<code>provider.no-route</code>");
    expect(msg).toContain("Model unavailable");
  });
});
