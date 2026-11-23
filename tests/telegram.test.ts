import { describe, expect, test } from "bun:test";
import { boundedRetryAfter, redactToken, TelegramClient, TelegramError } from "../src/telegram.ts";

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
    const res =
      out instanceof Response
        ? out
        : new Response(JSON.stringify(out), {
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
    const id = await client.sendMessage("hello", {
      buttons: [[{ text: "B", callback_data: "x" }]],
    });
    expect(id).toBe(42);
    expect(captured[0].url).toContain(`/bot${TOKEN}/sendMessage`);
    expect(captured[0].body.chat_id).toBe(CHAT);
    expect(captured[0].body.disable_web_page_preview).toBe(true);
    const rm = captured[0].body.reply_markup as { inline_keyboard: unknown[][] };
    expect(rm.inline_keyboard[0][0]).toEqual({ text: "B", callback_data: "x" });
  });

  test("client errors are terminal and token is redacted", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ ok: false, description: `whoa ${TOKEN} broken` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
    );
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

  test("429 retries with a clamped back-off instead of stalling the queue", async () => {
    let attempts = 0;
    const { impl } = fakeFetch(() => {
      attempts++;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ ok: false, description: "flood", parameters: { retry_after: 3600 } }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }
      return { ok: true, result: { message_id: 7 } };
    });
    const client = new TelegramClient({
      token: TOKEN,
      chatId: CHAT,
      fetchImpl: impl,
      maxRetryAfterMs: 10, // test clock: the 3600 s response must not stall
    });
    const started = Date.now();
    const id = await client.sendMessage("x");
    expect(id).toBe(7);
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("editMessageText treats 'message is not modified' as success", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          }
        )
    );
    const client = new TelegramClient({ token: TOKEN, chatId: CHAT, fetchImpl: impl });
    await expect(client.editMessageText(5, "same text")).resolves.toBeUndefined();
  });

  test("a real edit error still propagates", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, description: "Bad Request: message to edit not found" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          }
        )
    );
    const client = new TelegramClient({ token: TOKEN, chatId: CHAT, fetchImpl: impl });
    await expect(client.editMessageText(5, "gone")).rejects.toBeInstanceOf(TelegramError);
  });

  test("getUpdates forwards an abort signal from the caller", async () => {
    const client = new TelegramClient({
      token: TOKEN,
      chatId: CHAT,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        }),
    });
    const controller = new AbortController();
    const pending = client.getUpdates(0, 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TelegramError);
  });
});

describe("redactToken", () => {
  test("hides both secret and numeric id", () => {
    const out = redactToken(`url /bot${TOKEN}/get and ${TOKEN}`, TOKEN);
    expect(out.includes(TOKEN)).toBe(false);
    expect(out.includes("1111111111")).toBe(false);
  });
});

describe("boundedRetryAfter", () => {
  test("clamps Telegram retry_after to a sane window", () => {
    expect(boundedRetryAfter(undefined)).toBe(3000);
    expect(boundedRetryAfter(1)).toBe(1000);
    expect(boundedRetryAfter(3600)).toBe(30_000);
    expect(boundedRetryAfter(0)).toBe(1000);
    expect(boundedRetryAfter(5, 10_000)).toBe(5000);
    expect(boundedRetryAfter(3600, 10)).toBe(10);
  });
});
