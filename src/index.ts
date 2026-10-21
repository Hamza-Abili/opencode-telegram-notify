/**
 * opencode-telegram-notify — plugin entry.
 *
 * Contract (opencode v2): default export `{id, setup}`; `setup` may return a
 * dispose function. OpenCode 2.x passes the client directly (and supports an
 * async setup), while early builds passed a promise. Both are accepted:
 * the direct path starts synchronously; the promise path defers startup and
 * uses a guard so an immediate dispose cannot leak the app.
 */

import { type App, createApp } from "./app.ts";
import type { V2Client, V2PluginDefinition } from "./types.ts";

function isPromiseLike(value: unknown): value is PromiseLike<V2Client> {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

function start(client: V2Client): App | undefined {
  try {
    return createApp(client);
  } catch (error) {
    console.log(`[opencode-telegram-notify] failed to start: ${String(error)}`);
    return undefined;
  }
}

export default {
  id: "opencode-telegram-notify",
  setup(clientInput) {
    if (!isPromiseLike(clientInput)) {
      const app = start(clientInput);
      return () => app?.dispose();
    }

    let app: App | undefined;
    let disposed = false;
    void Promise.resolve(clientInput)
      .then((client) => {
        if (disposed) return;
        const started = start(client);
        if (disposed) {
          started?.dispose();
          return;
        }
        app = started;
      })
      .catch((error) => {
        console.log(`[opencode-telegram-notify] plugin client unavailable: ${String(error)}`);
      });

    return () => {
      disposed = true;
      app?.dispose();
      app = undefined;
    };
  },
} satisfies V2PluginDefinition;
