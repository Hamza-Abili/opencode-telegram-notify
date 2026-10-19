import { describe, expect, test } from "bun:test";
import { TelegramClient, TelegramError, redactToken } from "../src/telegram.ts";

const TOKEN = "1111111111:AAABBBsecretTOKEN/chat";
const CHAT = "123";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(responder: (url: string, body: Record<string, unknown>) => unknown | Response) {
  const captured: Captured[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    captured.push({ url, body });
    const out = responder(url.split("/").pop() ?? "", body);
    const res = out instanceof Response ? out : new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    return res;
  };
  return { impl, captured };
}

describe("TelegramClient", () => {
  test("sendMessage queue returns message id", async () => {
    const { impl, captured } = fakeFetch(() => ({ ok: true, result: { message_id: 42 } }));
    const client = new TelegramClient({ token: TOKEN, chatId: CHAT, fetchImpl: impl });
    const id = await client.sendMessage("hello", { buttons: [[{ text: "B", callback_data: "x" }]] });
    expect(id).toBe(42);
    expect(captured[0].url).toContain(`/bot${TOKEN}/sendMessage`);
    expect(captured[0].body.chat_id).toBe(CHAT);
    expect(captured[0].body.disable_web_page_preview).toBe(true);
    const rm = captured[0].body.reply_markup as { inline_keyboard: unknown[][] };
    expect(rm.inline_keyboard[0][0]).toEqual({ text: "B", callback_data: "x" });
  });

  test("client errors are terminal and token is redacted", async () => {
    const { impl } = fakeFetch(() => new Response(
      JSON.stringify({ ok: false, description: `whoa ${TOKEN} broken` }),
      { status: 400, headers: { "content-type": "application/json" } }
    ));
    const client = new TelegramClient({ token: TOKEN, chatId: CHAT, fetchImpl: impl });
    let error: unknown;
    try {
      await client.sendMessage("x");
    } catch (e) {
      error = e;
    }
    expect(error instanceof TelegramError).toBe(true);
    expect((error as Error).message.includes(TOKEN)).toBe(false);
  });

  test("getUpdates passes long-poll timeout and offset", async () => {
    const { impl, captured } = fakeFetch(() => ({ ok: true, result: [] }));
    const client = new TelegramClient({ token: TOKEN, chatId: CHAT, fetchImpl: impl });
    await client.getUpdates(7, 3);
    expect(captured[0].body.offset).toBe(7);
    expect(captured[0].body.timeout).toBe(3);
  });

  test("setMyCommands posts command list", async () => {
    const { impl, captured } = fakeFetch(() => ({ ok: true, result: true }));
    const client = new TelegramClient({ token: TOKEN, chatId: CHAT, fetchImpl: impl });
    await client.setMyCommands([{ command: "start", description: "Connect" }]);
    expect(captured[0].body.commands).toHaveLength(1);
  });
});

describe("redactToken", () => {
  test("hides both secret and numeric id", () => {
    const out = redactToken(`url /bot${TOKEN}/get and ${TOKEN}`, TOKEN);
    expect(out.includes(TOKEN)).toBe(false);
    expect(out.includes("1111111111")).toBe(false);
  });
});
