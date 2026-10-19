/**
 * opencode-telegram-notify — cross-process poller lock.
 *
 * Telegram's getUpdates allows exactly one consumer per bot token. When an
 * opencode instance already holds it, other instances stand by. The lock is
 * a small JSON file carrying {pid, at}; ownership is proven by a live pid,
 * staleness by an old `at` timestamp.
 */

import fs from "node:fs";
import path from "node:path";

export interface PollerLock {
  /** Try to take the lock. `true` when this process holds it now. */
  tryAcquire(): boolean;
  /** Update the heartbeat timestamp (safe no-op when not owner). */
  heartbeat(): void;
  /** Release ownership if held. Idempotent. */
  release(): void;
  /** Absolute lock file path. */
  readonly file: string;
  /** Whether this process currently owns the lock. */
  readonly held: boolean;
}

export interface LockOptions {
  /** A lock older than this is considered abandoned (ms). */
  staleMs?: number;
  /** Injection point for clock (tests). */
  now?: () => number;
  log?: (m: string) => void;
}

interface LockBody {
  pid: number;
  at: number;
}

function sameAlive(pid: number): boolean {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as { code?: string };
    // no permissions → alive; anything else → not running
    return err.code === "EPERM";
  }
}

export function openPollerLock(dir: string, options: LockOptions = {}): PollerLock {
  const staleMs = options.staleMs ?? 30_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const lockFile = path.join(dir, "poller.lock");

  let ownerPid: number | null = null;

  function readBody(): LockBody | null {
    try {
      const raw = fs.readFileSync(lockFile, "utf8");
      const parsed = JSON.parse(raw) as LockBody;
      if (typeof parsed.pid === "number" && typeof parsed.at === "number") return parsed;
    } catch {
      // missing or malformed → treat as absent
    }
    return null;
  }

  function claim(): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const body: LockBody = { pid: process.pid, at: now() };
      fs.writeFileSync(lockFile, JSON.stringify(body), { flag: "wx" });
      ownerPid = process.pid;
      return true;
    } catch (error) {
      const err = error as { code?: string };
      if (err.code !== "EEXIST") {
        log(`lock: cannot create ${lockFile}: ${String(error)}`);
      }
      return false;
    }
  }

  function stealStale(): void {
    const body = readBody();
    if (body) {
      if (sameAlive(body.pid) && now() - body.at <= staleMs) return; // guarded, leave it
      try {
        fs.unlinkSync(lockFile);
        log(`lock: replaced stale lock (pid=${body.pid})`);
      } catch {
        // someone else may have unlinked/rewritten concurrently
      }
    }
    claim();
  }

  const lock: PollerLock = {
    file: lockFile,
    get held(): boolean {
      return ownerPid === process.pid;
    },
    tryAcquire(): boolean {
      if (lock.held) return true;
      if (claim()) return true;
      stealStale();
      return lock.held;
    },
    heartbeat(): void {
      if (!lock.held) return;
      try {
        const body: LockBody = { pid: process.pid, at: now() };
        // rewrite atomically enough for our purpose
        fs.writeFileSync(lockFile, JSON.stringify(body));
      } catch {
        // next heartbeat will retry
      }
    },
    release(): void {
      const body = readBody();
      if (body && body.pid === process.pid) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // already gone
        }
      }
      ownerPid = null;
    },
  };
  return lock;
}
