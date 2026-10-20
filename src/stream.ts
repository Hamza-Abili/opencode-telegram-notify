/**
 * opencode-telegram-notify — event stream subscription and cancellation.
 *
 * The v2 client accepts `subscribe({ signal })`; older adapters accepted a
 * positional signal or no argument. Subscription is probed in that order, and
 * the iterator is also raced against the abort signal so dispose is prompt
 * even when the host ignores the signal.
 */

import type { V2Client, V2EventEnvelope } from "./types.ts";

export function subscribeEvents(
  client: V2Client,
  signal: AbortSignal
): AsyncIterable<V2EventEnvelope> | undefined {
  const subscribe = client.event?.subscribe;
  if (!subscribe) return undefined;
  try {
    return subscribe.call(client.event, { signal });
  } catch {
    // early v2 builds may expect a positional abort signal
  }
  try {
    return subscribe.call(client.event, signal);
  } catch {
    // last resort: legacy hosts with no cancellation support
  }
  try {
    return subscribe.call(client.event);
  } catch {
    return undefined;
  }
}

/**
 * Consume an event stream until it ends, errors, or `signal` aborts. The
 * iterator's `return()` is always called so generators/subscriptions release
 * their resources.
 */
export async function consumeEvents(
  stream: AsyncIterable<V2EventEnvelope>,
  signal: AbortSignal,
  onEvent: (envelope: V2EventEnvelope) => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let abortHandler: (() => void) | undefined;

  const aborted = new Promise<IteratorResult<V2EventEnvelope>>((resolve) => {
    abortHandler = () => resolve({ done: true, value: undefined });
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    while (!signal.aborted) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result.done) return;
      await onEvent(result.value);
    }
  } catch (error) {
    if (!signal.aborted) onError(error);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
    try {
      await iterator.return?.();
    } catch {
      // stream already closed
    }
  }
}
