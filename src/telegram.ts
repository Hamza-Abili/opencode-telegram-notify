/**
 * opencode-telegram-notify — zero-dependency Telegram Bot API client.
 *
 * Design rules:
 *  - no external bot framework (supply chain stays empty);
 *  - every network call has a timeout and tolerates failure without crashing opencode;
 *  - the bot token never appears in logs or thrown error messages;
 *  - sends are serialized via a single in-memory queue so bursts never collide.
 */

const API_BASE = "https://api.telegram.org/bot";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
/** Upper bound for Telegram 429 back-off: one response must never stall the queue. */
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

/**
 * Clamp a Telegram `retry_after` value to milliseconds within a sane window.
 * Telegram usually sends 1-3 s; a huge or missing value must not hang the
 * serialized send queue behind one flaky call.
 */
export function boundedRetryAfter(
  seconds: number | undefined,
  maxMs: number = DEFAULT_MAX_RETRY_AFTER_MS
): number {
  return Math.min(Math.max((seconds ?? 3) * 1000, 1000), maxMs);
}

/** Redact any token fragment found in a string. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  const head = token.split(":")[0] ?? token;
  return text.split(token).join("<redacted-token>").split(head).join("<redacted-id>");
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
  };
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string; first_name?: string };
  };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramClientOptions {
  token: string;
  /** Destination chat (id can be negative for groups). */
  chatId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Internal/test knob: upper bound for 429 back-off sleeps (default 30 s). */
  maxRetryAfterMs?: number;
}

export class TelegramClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TelegramClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  }

  /** Internal: one API call with timeout + bounded retries on 429/5xx/network. */
  private async request<T>(
    method: string,
    payload: Record<string, unknown>,
    opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    const url = `${API_BASE}${this.options.token}/${method}`;
    const JJ = Math.max(0, opts.retries ?? MAX_RETRIES);
    let lastError: unknown;
    for (let attempt = 0; attempt <= JJ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
      // An outer signal (caller dispose) aborts the in-flight attempt promptly.
      const onOuterAbort = (): void => controller.abort();
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: T;
          description?: string;
          parameters?: { retry_after?: number };
        };
        if (res.ok && body.ok && body.result !== undefined) {
          return body.result;
        }
        const code = res.status;
        const description = redactToken(
          String(body.description ?? `HTTP ${code}`),
          this.options.token
        );
        if (code === 429) {
          lastError = new TelegramError(description, code);
          if (attempt < JJ) {
            await sleep(boundedRetryAfter(body.parameters?.retry_after, this.maxRetryAfterMs));
          }
          continue;
        }
        if (code >= 500) {
          lastError = new TelegramError(description, code);
          if (attempt < JJ) await sleep(500 * 2 ** attempt);
          continue;
        }
        // 4xx: terminal, do not retry.
        throw new TelegramError(description, code);
      } catch (error) {
        lastError = error;
        if (error instanceof TelegramError) throw error; // terminal
        // Aborted from outside, or out of attempts: no point backing off.
        if (opts.signal?.aborted || attempt === JJ) break;
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    throw new TelegramError(
      redactToken(`telegram ${method} failed: ${String(lastError)}`, this.options.token)
    );
  }

  /** Queue a task so concurrent notifications never collide. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Send a message; returns the created message id (for later edits). */
  sendMessage(
    text: string,
    options: { buttons?: InlineButton[][]; silent?: boolean } = {}
  ): Promise<number | undefined> {
    return this.enqueue(async () => {
      const payload: Record<string, unknown> = {
        chat_id: this.options.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: options.silent === true,
      };
      if (options.buttons?.length) payload.reply_markup = { inline_keyboard: options.buttons };
      const result = await this.request<{ message_id: number }>("sendMessage", payload);
      return result?.message_id;
    });
  }

  /** Edit a previously sent message (also replaces inline buttons). */
  editMessageText(
    messageId: number,
    text: string,
    options: { buttons?: InlineButton[][] } = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      const payload: Record<string, unknown> = {
        chat_id: this.options.chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
      payload.reply_markup = options.buttons?.length
        ? { inline_keyboard: options.buttons }
        : { inline_keyboard: [] };
      try {
        await this.request<boolean>("editMessageText", payload);
      } catch (error) {
        // Editing to identical content is a Telegram no-op, not a failure.
        if (error instanceof TelegramError && /message is not modified/i.test(error.message)) {
          return;
        }
        throw error;
      }
    });
  }

  /** Acknowledge a button press (hides the spinner, shows the toast). */
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      await this.request<boolean>("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      });
    });
  }

  /** Long-poll updates. One consumer per bot token; conflict handling is upstream. */
  getUpdates(
    offset: number,
    longPollSeconds = 25,
    signal?: AbortSignal
  ): Promise<TelegramUpdate[]> {
    // Long polling needs a longer timeout than the server wait, and no retries:
    // the caller loop retries every cycle anyway.
    return this.request<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: longPollSeconds, allowed_updates: ["callback_query", "message"] },
      { timeoutMs: (longPollSeconds + 5) * 1000, retries: 0, signal }
    );
  }

  /** Register the bot command menu (the ☰ menu button in Telegram). */
  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.enqueue(async () => {
      await this.request<boolean>("setMyCommands", { commands });
      return true;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
