/**
 * opencode-telegram-notify — application wiring.
 *
 * One activation = one config → one Telegram client → one event router +
 * one poller (poller ownership is cross-process via a file lock).
 */

import fs from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { ConfigError, expandEnv, loadConfig } from "./config.ts";
import { type AppContext, createLogger } from "./context.ts";
import { createRouter } from "./events.ts";
import { startPoller } from "./poller.ts";
import { consumeEvents, subscribeEvents } from "./stream.ts";
import { TelegramClient } from "./telegram.ts";
import type { V2Client } from "./types.ts";

export interface App {
  dispose(): void;
}

function noop(): void {}

function logConfigFailure(rawOptions: Record<string, unknown>, error: unknown): void {
  const logFileRaw = rawOptions.logFile;
  const logFile =
    typeof logFileRaw === "string" && logFileRaw.trim() !== ""
      ? expandEnv(logFileRaw.trim())
      : undefined;
  const line = `configuration error: ${error instanceof Error ? error.message : String(error)}`;
  if (logFile) {
    try {
      fs.appendFileSync(
        logFile,
        `${new Date().toISOString()} [opencode-telegram-notify] ${line}\n`
      );
    } catch {
      // ignore
    }
  }
  console.log(`[opencode-telegram-notify] ${line}`);
}

export function createApp(client: V2Client): App {
  try {
    const config = loadConfig(client.options ?? {});
    return startConfigured(config, client);
  } catch (error) {
    const rawOptions = (client.options ?? {}) as Record<string, unknown>;
    logConfigFailure(rawOptions, error);
    if (!(error instanceof ConfigError)) {
      console.log(`[opencode-telegram-notify] unexpected startup error: ${String(error)}`);
    }
    return { dispose: noop };
  }
}

function startConfigured(config: ReturnType<typeof loadConfig>, client: V2Client): App {
  const { log, logError } = createLogger(config.telegram.botToken, config.logFile);

  const root = resolvePath(client.location?.directory ?? process.cwd());
  const telegram = new TelegramClient({
    token: config.telegram.botToken,
    chatId: config.telegram.chatId,
  });

  let silenced = false;
  let interactive = false;
  let router: ReturnType<typeof createRouter> | undefined;

  const ctx: AppContext = {
    config,
    client,
    telegram,
    root,
    project: basename(root) || "opencode",
    sessionTitles: new Map(),
    sessionDirs: new Map(),
    pending: new Map(),
    pendingForms: new Map(),
    permMsgs: new Map(),
    formMsgs: new Map(),
    get silenced(): boolean {
      return silenced;
    },
    set silenced(value: boolean) {
      silenced = value;
    },
    get interactive(): boolean {
      return interactive;
    },
    set interactive(value: boolean) {
      interactive = value;
    },
    log,
    logError,
  };

  const controller = new AbortController();
  // Start the poller before the router so `ctx.interactive` is known before
  // the first permission/question event is rendered.
  const stopPoller = startPoller(ctx, {
    onInteractiveChange(value) {
      interactive = value;
      if (value) void router?.recover();
    },
  });
  router = createRouter(ctx, { autoRecover: false });
  if (interactive) void router.recover();

  const stream = subscribeEvents(client, controller.signal);
  if (!stream) {
    logError("client.event.subscribe() unavailable — notifications disabled");
  } else {
    void consumeEvents(
      stream,
      controller.signal,
      (envelope) => router?.handle(envelope),
      (error) => logError(`event stream ended: ${String(error)}`)
    );
  }

  return {
    dispose(): void {
      controller.abort();
      router?.dispose();
      stopPoller();
      interactive = false;
    },
  };
}
