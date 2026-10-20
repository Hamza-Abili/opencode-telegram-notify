/**
 * opencode-telegram-notify — tests for the OpenCode v1 legacy adapter.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import {
  default as createLegacyPlugin,
  createV1Core,
  createV1EventMapper,
  type V1PluginInput,
} from "../src/legacy.ts";

const ROOT = "/tmp/proj";

describe("v1 event mapper", () => {
  const map = createV1EventMapper(ROOT);

  const withLocation = (envelope: {
    id: string;
    type: string;
    created?: number;
    data: unknown;
  }) => ({
    ...envelope,
    location: { directory: ROOT },
  });

  test("maps permission.updated with command/path metadata", () => {
    const envelope = map({
      type: "permission.updated",
      properties: {
        id: "p_1",
        sessionID: "ses_1",
        title: "Run shell command",
        metadata: { command: ["bun test src", "npm ci"], path: "" },
        time: { created: 123 },
      },
    });
    expect(envelope).toEqual(
      withLocation({
        id: "v1:permission.asked:p_1",
        type: "permission.asked",
        created: 123,
        data: {
          id: "p_1",
          sessionID: "ses_1",
          action: "Run shell command",
          resources: ["bun test src", "npm ci"],
        },
      })
    );
  });

  test("maps permission.asked (post-rework payload) including patterns, always and tool", () => {
    const envelope = map({
      type: "permission.asked",
      properties: {
        id: "p_5",
        sessionID: "ses_1",
        permission: "Edit file",
        patterns: ["src/**"],
        metadata: { command: "sed -i" },
        always: ["bash:*"],
        tool: { messageID: "msg_1", callID: "call_1" },
      },
    });
    expect(envelope).toEqual(
      withLocation({
        id: "v1:permission.asked:p_5",
        type: "permission.asked",
        data: {
          id: "p_5",
          sessionID: "ses_1",
          action: "Edit file",
          resources: ["src/**", "sed -i"],
          save: ["bash:*"],
          source: { type: "tool", messageID: "msg_1", id: "call_1" },
        },
      })
    );
  });

  test("maps both reply field generations (response/permissionID vs reply/requestID)", () => {
    const legacy = map({
      type: "permission.replied",
      properties: { sessionID: "ses_1", permissionID: "p_6", response: "once" },
    });
    expect(legacy?.data).toEqual({ sessionID: "ses_1", requestID: "p_6", reply: "once" });

    const modern = map({
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "p_7", reply: "always" },
    });
    expect(modern?.id).toBe("v1:permission.replied:p_7:always");
    expect(modern?.data).toEqual({ sessionID: "ses_1", requestID: "p_7", reply: "always" });

    expect(
      map({ type: "permission.replied", properties: { requestID: "p_8", reply: "maybe" } })
    ).toBeUndefined();
  });

  test("derives stable ids for permission events so replays dedupe", () => {
    const event = {
      type: "permission.updated",
      properties: { id: "p_2", sessionID: "ses_1", title: "Edit file" },
    };
    expect(map(event)?.id).toBe("v1:permission.asked:p_2");
    expect(
      map({
        type: "permission.replied",
        properties: { permissionID: "p_2", response: "once", sessionID: "ses_1" },
      })?.id
    ).toBe("v1:permission.replied:p_2:once");
  });

  test("skips permission.replied with an unknown response verb", () => {
    expect(
      map({ type: "permission.replied", properties: { permissionID: "p_3", response: "maybe" } })
    ).toBeUndefined();
  });

  test("maps lifecycle events with occurrence-unique ids", () => {
    const busy = map({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    });
    expect(busy?.type).toBe("session.execution.started");
    const busy2 = map({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    });
    expect(busy2?.id).not.toBe(busy?.id);
    expect(map({ type: "session.idle", properties: { sessionID: "ses_1" } })).toEqual(
      withLocation({
        id: expect.any(String) as string,
        type: "session.execution.succeeded",
        data: { sessionID: "ses_1" },
      })
    );
  });

  test("maps aborted errors to silent interruption, others to failure", () => {
    const aborted = map({
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
    });
    expect(aborted?.type).toBe("session.execution.interrupted");
    expect(aborted?.data).toBeDefined();
    const abortedData = aborted?.data as { reason: string } | undefined;
    expect(abortedData?.reason).toBe("aborted");

    const failed = map({
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    });
    expect(failed?.type).toBe("session.execution.failed");
    expect(failed?.data).toBeDefined();
    const failedData = failed?.data as { error: { type: string; message: string } } | undefined;
    expect(failedData?.error).toEqual({
      type: "UnknownError",
      message: "boom",
    });
  });

  test("skips session events without a session", () => {
    expect(map({ type: "session.idle", properties: {} })).toBeUndefined();
    expect(
      map({ type: "session.error", properties: { error: { name: "UnknownError" } } })
    ).toBeUndefined();
  });

  test("tracks titles via created and only forwards real updated changes", () => {
    expect(
      map({
        type: "session.created",
        properties: { info: { id: "ses_9", title: "Work", time: { updated: 1 } } },
      })
    ).toEqual(
      withLocation({
        id: "v1:session.created:ses_9:1",
        type: "session.created",
        data: { sessionID: "ses_9", parentID: undefined, title: "Work" },
      })
    );
    // Repeated identity update → skipped.
    expect(
      map({ type: "session.updated", properties: { info: { id: "ses_9", title: "Work" } } })
    ).toBeUndefined();
    // Title change → forwarded as session.created for attribution.
    const changed = map({
      type: "session.updated",
      properties: { info: { id: "ses_9", title: "Fix bug" } },
    });
    expect(changed?.type).toBe("session.created");
    const changedData = changed?.data as { title: string } | undefined;
    expect(changedData?.title).toBe("Fix bug");
    // Parent assignment arrives once, then repeats are skipped.
    const parented = map({
      type: "session.updated",
      properties: { info: { id: "ses_9", parentID: "ses_1" } },
    });
    const parentedData = parented?.data as { parentID: string } | undefined;
    expect(parentedData?.parentID).toBe("ses_1");
    expect(
      map({ type: "session.updated", properties: { info: { id: "ses_9", parentID: "ses_1" } } })
    ).toBeUndefined();
    // session.deleted resets the ledger and reaches the router for cache cleanup.
    const deleted = map({ type: "session.deleted", properties: { info: { id: "ses_9" } } });
    expect(deleted?.type).toBe("session.deleted");
    expect(deleted?.data).toBeDefined();
    const deletedData = deleted?.data as { sessionID: string } | undefined;
    expect(deletedData?.sessionID).toBe("ses_9");
  });

  test("recreate-after-delete forwards creation again (ledger reset)", () => {
    // After deletion the title ledger forgets the session; a recreated session
    // with the same id forwards its creation again (dedupe id includes time).
    const map = createV1EventMapper(ROOT);
    map({
      type: "session.created",
      properties: { info: { id: "ses_x", title: "T", time: { updated: 5 } } },
    });
    map({ type: "session.deleted", properties: { info: { id: "ses_x" } } });
    const again = map({
      type: "session.created",
      properties: { info: { id: "ses_x", title: "T", time: { updated: 6 } } },
    });
    expect(again?.id).toBe("v1:session.created:ses_x:6");
  });

  test("ignores unrelated v1 events", () => {
    expect(
      map({ type: "todo.updated", properties: { sessionID: "a", todos: [] } })
    ).toBeUndefined();
    expect(map({ type: "message.part.updated", properties: {} })).toBeUndefined();
    expect(map(undefined)).toBeUndefined();
    expect(map({ properties: {} })).toBeUndefined();
  });
});

describe("v1 core", () => {
  test("disabled when client or directory is missing", () => {
    expect(createV1Core({})).toBeUndefined();
    expect(createV1Core({ client: {}, directory: ROOT })).toBeUndefined();
    expect(createV1Core({ client: { postSessionIdPermissionsPermissionId() {} } })).toBeUndefined();
    expect(
      createV1Core({ directory: ROOT, client: { permission: { async list() {} } } })
    ).toBeUndefined();
  });

  test("accepts the modern-only client generation (permission.reply namespace)", async () => {
    const modern: unknown[] = [];
    const core = createV1Core({
      directory: ROOT,
      client: {
        permission: {
          async reply(input: unknown) {
            modern.push(input);
          },
        },
      },
    });
    expect(core).toBeDefined();
    await core?.client.permission?.reply({
      sessionID: "ses_1",
      requestID: "p_9",
      decision: "always",
    });
    expect(modern[0]).toEqual({ requestID: "p_9", reply: "always" });
  });

  test("exposes the v2 surface backed by the v1 SDK", async () => {
    const calls: unknown[] = [];
    const core = createV1Core({
      directory: ROOT,
      client: {
        async postSessionIdPermissionsPermissionId(input: unknown) {
          calls.push(input);
        },
      },
    });
    expect(core).toBeDefined();
    const envelopePromise = core!.client.event!.subscribe()[Symbol.asyncIterator]().next();
    core!.pushEvent({
      type: "permission.updated",
      properties: { id: "p_9", sessionID: "ses_1", title: "Run shell command" },
    });
    const { value } = await envelopePromise;
    expect(value.type).toBe("permission.asked");

    await core?.client.permission?.reply({
      sessionID: "ses_1",
      requestID: "p_9",
      decision: "once",
    });
    expect(calls[0]).toEqual({
      path: { id: "ses_1", permissionID: "p_9" },
      query: { directory: ROOT },
      body: { response: "once" },
    });
  });

  test("legacy failure falls back to the modern surface", async () => {
    const modern: unknown[] = [];
    const core = createV1Core({
      directory: ROOT,
      client: {
        async postSessionIdPermissionsPermissionId() {
          throw new Error("legacy down");
        },
        permission: {
          async reply(input: unknown) {
            modern.push(input);
          },
        },
      },
    });
    await core?.client.permission?.reply({ sessionID: "s1", requestID: "q1", decision: "reject" });
    expect(modern[0]).toEqual({ requestID: "q1", reply: "reject" });
  });

  test("legacy-only failure propagates to the caller", async () => {
    const core = createV1Core({
      directory: ROOT,
      client: {
        async postSessionIdPermissionsPermissionId() {
          throw new Error("down");
        },
      },
    });
    await expect(
      core?.client.permission?.reply({ sessionID: "s1", requestID: "q1", decision: "once" })
    ).rejects.toThrow("down");
  });

  test("event queue is bounded with drop-oldest", async () => {
    const core = createV1Core({
      directory: ROOT,
      client: { postSessionIdPermissionsPermissionId() {} },
    });
    const iterator = core!.client.event!.subscribe()[Symbol.asyncIterator]();
    for (let i = 0; i < 260; i++) {
      core!.pushEvent({ type: "session.idle", properties: { sessionID: `SES_${i}` } });
    }
    const { value } = await iterator.next();
    // 10 oldest of 260 dropped against the 250-slot queue.
    expect((value.data as { sessionID: string }).sessionID).toBe("SES_10");
  });

  test("pushEvent drops unmapped events", async () => {
    const core = createV1Core({
      directory: ROOT,
      client: { postSessionIdPermissionsPermissionId() {} },
    });
    core!.pushEvent({ type: "todo.updated", properties: {} });
    const race = core!.client.event!.subscribe()[Symbol.asyncIterator]().next();
    const winner = await Promise.race([
      race.then(() => "mapped"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(winner).toBe("pending");
  });
});

describe("v1 default export", () => {
  test("is a factory that yields hooks; disabled path stays inert", async () => {
    expect(typeof createLegacyPlugin).toBe("function");
    const hooks = (
      createLegacyPlugin as unknown as (input: V1PluginInput) => {
        event(input: { event: unknown }): Promise<void>;
      }
    )({});
    expect(typeof hooks.event).toBe("function");
    // No client → inert; must not throw on events.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
  });
});

describe("v1 environment-driven config", () => {
  const ENV = {
    TELEGRAM_BOT_TOKEN: "1:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_LANGUAGE: "it",
  };

  test("language falls back to TELEGRAM_LANGUAGE when options omit it", () => {
    expect(loadConfig({}, ENV).language).toBe("it");
    expect(loadConfig({}, { ...ENV, TELEGRAM_LANGUAGE: "en" }).language).toBe("en");
    // Explicit options always win over the environment.
    expect(loadConfig({ language: "en" }, ENV).language).toBe("en");
  });

  test("v1 core options stay empty so config resolves from the environment", () => {
    const core = createV1Core({
      directory: ROOT,
      client: { postSessionIdPermissionsPermissionId() {} },
    });
    expect(core?.client.options).toEqual({});
  });
});
