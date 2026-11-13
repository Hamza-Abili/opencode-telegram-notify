import type { Catalog } from "./en.ts";

export const zh = {
  // 标题与标签
  permission: "🔐 权限请求",
  question: "❓ 问题",
  completed: "✅ 任务已完成",
  failed: "❌ 任务失败",
  cancelled: "⏹ 任务已取消",
  project: "项目",
  session: "会话",
  eventsLabel: "事件",
  empty: "（无详情）",

  // 权限按钮与结果
  answerOnce: "仅允许一次",
  answerAlways: "始终允许",
  answerReject: "拒绝",
  doneAllowed: "✅ 已允许（{decision}）",
  doneRejected: "🚫 已拒绝",
  doneCancelled: "⏹ 已取消",
  decisionOnce: "一次",
  decisionAlways: "始终",
  decisionReject: "拒绝",

  // 问题按钮与结果
  doneAnswered: "✅ 已通过 Telegram 回答",
  doneSkipped: "⏹ 已通过 Telegram 跳过",
  questionSkip: "⏹ 跳过",
  answeredInTerminal: "已在终端中回答",
  expiredOrStale: "已过期或已在其他地方回答",

  // 终端回退提示
  answerInTerminal: "⌨️ 请在终端中回答 — 此问题类型不支持点击回答。",
  permissionAnswerInTerminal: "⌨️ 请在终端中回答 — 此通知不支持点击回答。",
  replyFailedRetry: "发送回复失败 — 请重试点击或在终端中回答。",
  answerWithButtons: "👆 在下方回答 — 单击即可发送给智能体，绝不会自动提交。",

  // 机器人命令
  start: [
    "🤖 <b>opencode-telegram-notify</b> 已上线。",
    "聊天 ID：<code>{chatId}</code>",
    "你将收到权限请求、问题和任务生命周期通知。",
    "权限按钮仅支持点击：绝不会自动批准。",
  ].join("\n"),
  help: [
    "命令：",
    "/start — 连接信息 + 聊天 ID",
    "/status — 插件状态",
    "/setup — 可直接复制的配置",
    "/stop — 静音此聊天",
    "未知命令和普通消息将被忽略。",
  ].join("\n"),
  shuttingDone: "🔕 已静音此聊天。按 /start 重新启用。",
  statusOnline: "🟢 插件运行中",
  statusInteractive: "🖲 点击按钮：已启用",
  statusStandby: "💤 点击按钮：待机（另一个实例正在轮询）",
  statusActive: "🔔 通知已启用",
  statusSilenced: "🔕 已静音（使用 /start）",
  commandStart: "连接 + 聊天 ID",
  commandStatus: "插件状态",
  commandSetup: "复制配置",
  commandStop: "静音直到 /start",
  commandHelp: "此机器人的功能",
  envVars: "环境变量：",

  // 用量与错误标签
  usageLabel: "⚡",
  usageIn: "输入",
  usageOut: "输出",
  limitFree: "⛔ 已达到免费使用上限",
  limitQuota: "⛔ 已达到服务商配额",
  limitRate: "⛔ 已达到速率限制",
  limitBudget: "⛔ 已达到工作区预算",
  limitModelBudget: "⛔ 已达到模型预算",
} satisfies Catalog;
