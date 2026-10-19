/**
 * opencode-telegram-notify — plugin entry.
 *
 * Contract (opencode v2): default export `{id, setup}`; `setup` may return a
 * dispose function. `setup` stays synchronous (the loader consumes the
 * returned dispose directly); client resolution and app start happen inside
 * a floating async routine that honors an early dispose.
 */

import { createApp, type App } from "./app.ts";
import type { V2Client, V2PluginDefinition } from "./types.ts";

async function resolveClient(input: unknown): Promise<V2Client | undefined> {
  try {
    return (await input) as V2Client;
  } catch {
    return undefined;
  }
}

export default {
  id: "opencode-telegram-notify",
  setup(clientInput) {
    let app: App | undefined;
    let disposed = false;

    void (async () => {
      const client = await resolveClient(clientInput);
      if (!client) {
        console.log("[opencode-telegram-notify] plugin client unavailable — disabled");
        return;
      }
      if (disposed) return;
      try {
        const started = createApp(client);
        if (disposed) {
          started.dispose();
          return;
        }
        app = started;
      } catch (error) {
        console.log(`[opencode-telegram-notify] failed to start: ${String(error)}`);
      }
    })();

    return () => {
      disposed = true;
      app?.dispose();
    };
  },
} satisfies V2PluginDefinition;
