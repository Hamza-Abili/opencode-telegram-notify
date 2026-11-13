/**
 * Canonical English message catalog.
 *
 * Every other locale must define exactly these keys (`satisfies Catalog`).
 * Values are Telegram HTML: keep tags and `{placeholders}` intact.
 */
export const en = {
  // Headers and labels
  permission: "🔐 Permission request",
  question: "❓ Question",
  completed: "✅ Task completed",
  failed: "❌ Task failed",
  cancelled: "⏹ Task cancelled",
  project: "Project",
  session: "Session",
  eventsLabel: "Events",
  empty: "(no details)",

  // Permission buttons and outcomes
  answerOnce: "Allow once",
  answerAlways: "Always allow",
  answerReject: "Reject",
  doneAllowed: "✅ Allowed ({decision})",
  doneRejected: "🚫 Rejected",
  doneCancelled: "⏹ Cancelled",
  decisionOnce: "once",
  decisionAlways: "always",
  decisionReject: "rejected",

  // Question buttons and outcomes
  doneAnswered: "✅ Answered via Telegram",
  doneSkipped: "⏹ Skipped via Telegram",
  questionSkip: "⏹ Skip",
  answeredInTerminal: "Already answered (terminal)",
  expiredOrStale: "Outdated or answered elsewhere",

  // Terminal fallbacks
  answerInTerminal: "⌨️ Answer in your terminal — this question type is not tap-answerable.",
  permissionAnswerInTerminal:
    "⌨️ Answer in your terminal — tap-to-answer is unavailable for this notification.",
  replyFailedRetry: "Could not send the reply — tap again or answer in the terminal.",
  answerWithButtons:
    "👆 Answer below — a single tap sends it to the agent. Nothing is ever auto-submitted.",

  // Bot commands
  start: [
    "🤖 <b>opencode-telegram-notify</b> is online.",
    "Chat ID: <code>{chatId}</code>",
    "You will get notifications for permission requests, questions and task lifecycle.",
    "Permission buttons are tap-only: nothing is ever auto-approved.",
  ].join("\n"),
  help: [
    "Commands:",
    "/start — connection info + chat id",
    "/status — plugin status",
    "/setup — copy-paste ready config",
    "/stop — silence this chat",
    "Unknown commands and plain messages are ignored.",
  ].join("\n"),
  shuttingDone: "🔕 Chat silenced. Press /start to re-enable.",
  statusOnline: "🟢 Plugin running",
  statusInteractive: "🖲 Tap buttons: active",
  statusStandby: "💤 Tap buttons: standby (another instance is polling)",
  statusActive: "🔔 Notifications active",
  statusSilenced: "🔕 Silenced (use /start)",
  commandStart: "Connect + chat id",
  commandStatus: "Plugin status",
  commandSetup: "Copy-paste config",
  commandStop: "Silence until /start",
  commandHelp: "What this bot does",
  envVars: "Env vars:",

  // Usage and failure labels
  usageLabel: "⚡",
  usageIn: "in",
  usageOut: "out",
  limitFree: "⛔ Free usage limit reached",
  limitQuota: "⛔ Provider quota reached",
  limitRate: "⛔ Rate limit reached",
  limitBudget: "⛔ Workspace budget reached",
  limitModelBudget: "⛔ Model budget reached",
} as const;

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
