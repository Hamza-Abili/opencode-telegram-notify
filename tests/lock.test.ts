import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPollerLock } from "../src/lock.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otn-lock-"));
}

describe("openPollerLock", () => {
  test("acquire, heartbeat, release", () => {
    const dir = tmpdir();
    const now = { t: 10_000 };
    const lock = openPollerLock(dir, { now: () => now.t, staleMs: 2_000 });
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.held).toBe(true);
    const body = () => JSON.parse(fs.readFileSync(lock.file, "utf8"));
    expect(body().pid).toBe(process.pid);
    now.t = 20_000;
    lock.heartbeat();
    expect(body().at).toBe(20_000);
    lock.release();
    expect(lock.held).toBe(false);
    expect(fs.existsSync(lock.file)).toBe(false);
  });

  test("same process re-acquires own lock", () => {
    const dir = tmpdir();
    const lock = openPollerLock(dir, { now: () => 1 });
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  test("live foreign owner is respected", () => {
    const dir = tmpdir();
    const body = { pid: process.pid, at: Date.now() }; // same pid = "live"
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "poller.lock"), JSON.stringify(body));
    const now = { t: Date.now() };
    const lock = openPollerLock(dir, { now: () => now.t, staleMs: 10_000 });
    expect(lock.tryAcquire()).toBe(false);
    fs.unlinkSync(path.join(dir, "poller.lock"));
  });

  test("a second activation in the same process cannot release the first lock", () => {
    const dir = tmpdir();
    const first = openPollerLock(dir);
    const second = openPollerLock(dir);
    expect(first.tryAcquire()).toBe(true);
    expect(second.tryAcquire()).toBe(false);
    second.release(); // must not delete the owner's file
    expect(first.held).toBe(true);
    expect(fs.existsSync(first.file)).toBe(true);
    first.heartbeat();
    expect(first.held).toBe(true);
    first.release();
    expect(fs.existsSync(first.file)).toBe(false);
  });

  test("a stolen lock is detected by the next heartbeat", () => {
    const dir = tmpdir();
    const first = openPollerLock(dir);
    const second = openPollerLock(dir);
    expect(first.tryAcquire()).toBe(true);
    // Simulate a steal by writing a token that does not belong to `first`.
    fs.writeFileSync(
      first.file,
      JSON.stringify({ pid: process.pid, at: Date.now(), token: "other" })
    );
    first.heartbeat();
    expect(first.held).toBe(false);
    second.release();
    fs.unlinkSync(first.file);
  });

  test("dead foreign owner is taken over", () => {
    const dir = tmpdir();
    const body = { pid: 999_999_999, at: 1_000 };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "poller.lock"), JSON.stringify(body));
    const lock = openPollerLock(dir, { now: () => 2_000, staleMs: 10_000 });
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  test("a fresh malformed lock is left alone, then reclaimed once stale", () => {
    const dir = tmpdir();
    const file = path.join(dir, "poller.lock");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "{not json");
    const now = { t: Date.now() };
    const lock = openPollerLock(dir, { now: () => now.t, staleMs: 10_000 });
    expect(lock.tryAcquire()).toBe(false);
    // Age the file beyond the stale window without waiting in real time.
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(file, old, old);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });
});
