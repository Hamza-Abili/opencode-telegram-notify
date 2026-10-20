/**
 * opencode-telegram-notify — cross-process poller lock.
 *
 * Telegram's getUpdates allows exactly one consumer per bot token. When an
 * opencode instance already holds it, other instances stand by. The lock is
 * a small JSON file carrying {pid, at, token}; ownership is proven by a live
 * pid plus a per-activation token, staleness by an old `at` timestamp.
 */

import { randomUUID } from "node:crypto";
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
  token?: string;
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
  const token = randomUUID();

  let ownerPid: number | null = null;
  let ownerToken: string | null = null;

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

  function owns(body: LockBody | null): boolean {
    return (
      body !== null &&
      ownerPid === process.pid &&
      ownerToken !== null &&
      body.pid === process.pid &&
      body.token === ownerToken
    );
  }

  function clearOwnership(): void {
    ownerPid = null;
    ownerToken = null;
  }

  function claim(): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const body: LockBody = { pid: process.pid, at: now(), token };
      fs.writeFileSync(lockFile, JSON.stringify(body), { flag: "wx" });
      ownerPid = process.pid;
      ownerToken = token;
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
    } else {
      // A malformed file may be a torn write from a live owner. Wait for its
      // mtime to age out before reclaiming; otherwise a crash would deadlock
      // the poller forever.
      try {
        const age = now() - fs.statSync(lockFile).mtimeMs;
        if (age <= staleMs) return;
      } catch {
        // missing → safe to claim
      }
      try {
        fs.unlinkSync(lockFile);
        log("lock: replaced malformed stale lock");
      } catch {
        // already gone / racing
      }
    }
    claim();
  }

  function writeBody(body: LockBody): void {
    const tmp = `${lockFile}.${process.pid}.${token}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, lockFile);
  }

  const lock: PollerLock = {
    file: lockFile,
    get held(): boolean {
      return ownerPid === process.pid && ownerToken !== null;
    },
    tryAcquire(): boolean {
      if (lock.held) return true;
      if (claim()) return true;
      stealStale();
      return lock.held;
    },
    heartbeat(): void {
      if (!lock.held) return;
      const body = readBody();
      if (!owns(body)) {
        // Another activation stole the lock; stop pretending we own it.
        clearOwnership();
        return;
      }
      try {
        writeBody({ pid: process.pid, at: now(), token });
      } catch {
        // next heartbeat will retry
      }
    },
    release(): void {
      const body = readBody();
      if (owns(body)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // already gone
        }
      }
      clearOwnership();
    },
  };
  return lock;
}
