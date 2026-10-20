import { describe, expect, test } from "bun:test";
import { consumeEvents, subscribeEvents } from "../src/stream.ts";
import type { V2Client, V2EventEnvelope } from "../src/types.ts";

function envelope(id: string): V2EventEnvelope {
  return { id, type: "session.created", data: { sessionID: "ses_1" } };
}

describe("event stream", () => {
  test("subscribes with an options object and forwards the abort signal", () => {
    const controller = new AbortController();
    let seen: unknown;
    const iterable = (async function* () {})();
    const client: V2Client = {
      event: {
        subscribe(options) {
          seen = options;
          return iterable;
        },
      },
    };
    expect(subscribeEvents(client, controller.signal)).toBe(iterable);
    expect(seen).toEqual({ signal: controller.signal });
  });

  test("falls back to a positional signal when the host throws on options", () => {
    const controller = new AbortController();
    let seen: unknown;
    const client: V2Client = {
      event: {
        subscribe(options) {
          if (!(options instanceof AbortSignal)) throw new Error("positional only");
          seen = options;
          return (async function* () {})();
        },
      },
    };
    expect(subscribeEvents(client, controller.signal)).toBeDefined();
    expect(seen).toBe(controller.signal);
  });

  test("delivers events and closes the iterator on abort", async () => {
    const controller = new AbortController();
    const received: string[] = [];
    let closed = false;
    const stream = (async function* () {
      try {
        yield envelope("e1");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        yield envelope("e2");
      } finally {
        closed = true;
      }
    })();

    const done = consumeEvents(
      stream,
      controller.signal,
      async (event) => {
        received.push(event.id);
        controller.abort();
      },
      (error) => {
        throw error;
      }
    );
    await done;
    expect(received).toEqual(["e1"]);
    expect(closed).toBe(true);
  });

  test("reports a stream error unless the caller aborted", async () => {
    const controller = new AbortController();
    const errors: string[] = [];
    const stream = (async function* () {
      yield envelope("e1");
      throw new Error("socket closed");
    })();
    await consumeEvents(
      stream,
      controller.signal,
      async () => undefined,
      (error) => errors.push(String(error))
    );
    expect(errors[0]).toContain("socket closed");
  });
});
