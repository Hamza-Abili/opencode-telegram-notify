/**
 * Live smoke test against a real OpenCode installation.
 *
 * Starts an ephemeral `opencode serve` with this plugin configured and asserts
 * that OpenCode loads it: the v2 plugin entrypoint, the object-options form and
 * the event subscription all have to survive a real host.
 *
 * Telegram itself is not exercised: the token is a syntactically valid dummy,
 * the bot API rejects it, and the plugin is expected to keep running and log
 * the failure instead of taking the host down. That is the contract this smoke
 * covers — plugin compatibility, not notification delivery.
 *
 * Usage: bun run smoke   (or OPENCODE_BIN=/path bun run smoke)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ROOT = process.env.PLUGIN_SPEC ?? path.resolve(import.meta.dir, "..");
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";
const PLUGIN_ID = "opencode-telegram-notify";
const password = crypto.randomUUID();
const port = 50100 + (process.pid % 200);
const dummyToken = `123456:${"a".repeat(35)}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-smoke-"));
const project = path.join(root, "project");
// Minimal allowlist: never inherit Telegram, GitHub or npm credentials from the
// caller. Proxy/CA settings are forwarded because egress may need them; proxy
// URLs can embed credentials, so diagnostics are redacted below.
const env: NodeJS.ProcessEnv = {};
for (const key of [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SHELL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
env.HOME = path.join(root, "home");
env.XDG_CONFIG_HOME = path.join(root, "config");
env.XDG_DATA_HOME = path.join(root, "data");
env.XDG_CACHE_HOME = path.join(root, "cache");
env.XDG_RUNTIME_DIR = path.join(root, "runtime");
env.OPENCODE_SERVER_PASSWORD = password;
const logFile = path.join(root, "plugin.log");
const lockFile = path.join(env.XDG_CACHE_HOME as string, "opencode-telegram-notify", "poller.lock");

for (const dir of [
  env.HOME,
  env.XDG_CONFIG_HOME,
  env.XDG_DATA_HOME,
  env.XDG_CACHE_HOME,
  env.XDG_RUNTIME_DIR,
  project,
]) {
  fs.mkdirSync(dir as string, { recursive: true });
}

fs.mkdirSync(path.join(env.XDG_CONFIG_HOME as string, "opencode"), { recursive: true });
fs.writeFileSync(
  path.join(env.XDG_CONFIG_HOME as string, "opencode", "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: PLUGIN_ROOT,
        options: {
          telegram: { botToken: dummyToken, chatId: "1" },
          logFile,
        },
      },
    ],
  })
);

const child = Bun.spawn({
  cmd: [OPENCODE, "serve", "--port", String(port)],
  cwd: project,
  env,
  stdout: "pipe",
  stderr: "pipe",
});

function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@");
}

function fail(message: string): never {
  console.error(`FAIL: ${redact(message)}`);
  const pluginLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim() : "";
  if (pluginLog)
    console.error(`plugin log (tail):\n${redact(pluginLog).split("\n").slice(-10).join("\n")}`);
  if (stdoutTail.trim()) {
    console.error(
      `opencode stdout (tail):\n${redact(stdoutTail).trim().split("\n").slice(-10).join("\n")}`
    );
  }
  if (stderrTail.trim()) {
    console.error(
      `opencode stderr (tail):\n${redact(stderrTail).trim().split("\n").slice(-10).join("\n")}`
    );
  }
  process.exit(1);
}

let stopped = false;
let stdoutTail = "";
let stderrTail = "";
function stop(): void {
  if (stopped) return;
  stopped = true;
  try {
    child.kill();
  } catch {
    // already exited
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  append: (chunk: string) => void
): Promise<void> {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        append(decoder.decode());
        return;
      }
      append(decoder.decode(value, { stream: true }));
    }
  } catch {
    // server closed
  }
}

const drainDone = Promise.all([
  drain(child.stdout, (chunk) => {
    stdoutTail = (stdoutTail + chunk).slice(-4000);
  }),
  drain(child.stderr, (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  }),
]);

process.on("exit", () => {
  stop();
  if (process.env.TG_KEEP_SMOKE === "1") {
    console.error(`smoke root kept at ${root}`);
    return;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

async function api(pathname: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(3000),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await drainDone;
      const output = (stderrTail || stdoutTail).trim();
      fail(
        `OpenCode server exited before ${label}: ${output || `exit ${child.exitCode ?? child.signalCode}`}`
      );
    }
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  fail(`timed out waiting for ${label}`);
}

type PluginInfo = { id: string; state?: { status?: string; message?: string } };

const plugins = await waitFor("the plugin", async () => {
  const response = await api("/api/plugin");
  if (response.status !== 200) return undefined;
  const data = (response.body as { data?: PluginInfo[] }).data ?? [];
  return data.some((plugin) => plugin.id === PLUGIN_ID && plugin.state?.status === "active")
    ? data
    : undefined;
});
const plugin = plugins.find((candidate) => candidate.id === PLUGIN_ID);
console.log(`PASS plugin: ${plugin?.id} state=${plugin?.state?.status}`);

// The poller lock exists only after loadConfig() accepted the options and
// startPoller() ran. With TELEGRAM_* stripped from the child environment there
// is no fallback path, so this is the options-contract assertion.
await waitFor("the poller lock", async () => (fs.existsSync(lockFile) ? true : undefined), 10_000);
console.log("PASS options: telegram token and chat id accepted (poller started)");

await Bun.sleep(500);
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
const startupFailure = [
  "configuration error",
  "unexpected startup error",
  "failed to start",
  "event.subscribe() unavailable",
  "event stream ended",
  "poller crashed",
].find((marker) => log.includes(marker));
if (startupFailure !== undefined) {
  fail(`plugin reported a startup failure: ${startupFailure}`);
}
if (child.exitCode !== null || child.signalCode !== null) {
  fail("OpenCode server exited before the smoke completed");
}
console.log("PASS startup: no configuration, event-subscription or poller failure");

console.log(`PASS live smoke against ${OPENCODE}`);

// The Telegram poller keeps the child process (and Bun's event loop) alive
// after the assertions, so exit explicitly and let the exit handler clean up.
stop();
process.exit(0);
