/**
 * opencode-telegram-notify — application wiring.
 *
 * One activation = one config → one Telegram client → one event router +
 * one poller (poller ownership is cross-process via a file lock).
 */

import fs from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger, type AppContext } from "./context.ts";
import { createRouter } from "./events.ts";
import { startPoller } from "./poller.ts";
import { TelegramClient } from "./telegram.ts";
import type { V2Client, V2EventEnvelope } from "./types.ts";

export interface App {
  dispose(): void;
}

function noop(): void {}

function logConfigFailure(rawOptions: Record<string, unknown>, error: unknown): void {
  const logFileRaw = rawOptions.logFile;
  const logFile = typeof logFileRaw === "string" && logFileRaw.trim() !== "" ? logFileRaw.trim() : undefined;
  const line = `configuration error: ${error instanceof Error ? error.message : String(error)}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} [opencode-telegram-notify] ${line}\n`);
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
      console.log(`[opencode-telegram-notify] unexpected config error: ${String(error)}`);
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
    log,
    logError,
  };

  const router = createRouter(ctx);
  const stopPoller = startPoller(ctx);

  const controller = new AbortController();
  const pump = (async () => {
    try {
      const stream = client.event?.subscribe();
      if (!stream) {
        logError("client.event.subscribe() unavailable — notifications disabled");
        return;
      }
      for await (const envelope of stream as AsyncIterable<V2EventEnvelope>) {
        if (controller.signal.aborted) break;
        await router.handle(envelope);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logError(`event stream ended: ${String(error)}`);
      }
    }
  })();

  return {
    dispose(): void {
      controller.abort();
      router.dispose();
      stopPoller();
      void pump;
    },
  };
}
