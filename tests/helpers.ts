/**
 * opencode-telegram-notify — shared test helpers (fake contexts and clients).
 */

import type { AppConfig } from "../src/config.ts";
import type { AppContext } from "../src/context.ts";
import type { TelegramClient, TelegramUpdate } from "../src/telegram.ts";
import type { PermissionDecision, V2Client, V2EventEnvelope } from "../src/types.ts";

export interface FakeTelegramCalls {
  sent: { text: string; buttons: unknown; silent: boolean }[];
  edits: { messageId: number; text: string }[];
  toasts: { id: string; text: string }[];
  commands: { command: string; description: string }[][];
}

export function fakeTelegram(): { calls: FakeTelegramCalls; telegram: TelegramClient } {
  const calls: FakeTelegramCalls = { sent: [], edits: [], toasts: [], commands: [] };
  const obj = {
    async sendMessage(text: string, opts: { buttons?: unknown; silent?: boolean } = {}) {
      calls.sent.push({ text, buttons: opts.buttons, silent: opts.silent === true });
      return 900 + calls.sent.length;
    },
    async editMessageText(messageId: number, text: string) {
      calls.edits.push({ messageId, text });
    },
    async answerCallbackQuery(id: string, text: string) {
      calls.toasts.push({ id, text });
    },
    async getUpdates() {
      return [] as TelegramUpdate[];
    },
    async setMyCommands(list: { command: string; description: string }[]) {
      calls.commands.push(list);
      return true;
    },
  };
  return { calls, telegram: obj as unknown as TelegramClient };
}

export function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    telegram: { botToken: "1:x", chatId: "5", allowedUserIds: [] },
    language: "en",
    events: { permission: true, question: true, idle: true, error: true, usage: true },
    interactions: true,
    idleDebounceMs: 10,
    idleCooldownMs: 0,
    maxMessageChars: 3800,
    hideCommands: false,
    ...overrides,
  };
}

export interface FakeV2Client extends V2Client {
  answered: { sessionID: string; requestID: string; decision: PermissionDecision }[];
  questionAnswers: { requestID: string; answers?: string[][] }[];
  questionRejects: { requestID: string }[];
}

export function fakeClient(root = "/tmp/proj"): FakeV2Client {
  const answered: { sessionID: string; requestID: string; decision: PermissionDecision }[] = [];
  const questionAnswers: { requestID: string; answers?: string[][] }[] = [];
  const questionRejects: { requestID: string }[] = [];
  const client = {
    location: { directory: root },
    permission: {
      async reply(input: {
        sessionID: string;
        requestID: string;
        decision?: PermissionDecision;
        reply?: PermissionDecision;
      }) {
        answered.push({
          sessionID: input.sessionID,
          requestID: input.requestID,
          decision: input.decision ?? input.reply ?? "once",
        });
      },
    },
    question: {
      async reply(input: { requestID: string; answers?: string[][] }) {
        questionAnswers.push(input);
      },
      async reject(input: { requestID: string }) {
        questionRejects.push({ requestID: input.requestID });
      },
      async list() {
        return [];
      },
    },
    event: {
      subscribe() {
        return (async function* () {})();
      },
    },
  };
  return Object.assign(client as V2Client, {
    answered,
    questionAnswers,
    questionRejects,
  });
}

export function mkContext(
  root = "/tmp/proj",
  overrides: Partial<AppConfig> = {}
): {
  ctx: AppContext;
  calls: FakeTelegramCalls;
  answered: { sessionID: string; requestID: string; decision: PermissionDecision }[];
  questionAnswers: { requestID: string; answers?: string[][] }[];
  questionRejects: { requestID: string }[];
} {
  const { calls, telegram } = fakeTelegram();
  const client = fakeClient(root);
  const ctx: AppContext = {
    config: config(overrides),
    client,
    telegram,
    root,
    project: "proj",
    sessionTitles: new Map(),
    sessionDirs: new Map(),
    pending: new Map(),
    pendingForms: new Map(),
    permMsgs: new Map(),
    formMsgs: new Map(),
    silenced: false,
    interactive: true,
    log: () => undefined,
    logError: () => undefined,
  };
  return {
    ctx,
    calls,
    answered: client.answered,
    questionAnswers: client.questionAnswers,
    questionRejects: client.questionRejects,
  };
}

export function env(
  id: string,
  type: string,
  data: unknown,
  directory: string | undefined = "/tmp/proj"
): V2EventEnvelope {
  return {
    id,
    type,
    location: directory ? { directory } : undefined,
    data,
  };
}

/** A representative permission.asked payload. */
export const permissionAsked = (id: string, sessionID = "ses_1") => ({
  id,
  sessionID,
  action: "shell",
  resources: ["ls"],
  source: { type: "tool" },
});
