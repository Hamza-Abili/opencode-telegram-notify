# Changelog

## 0.2.2 — poller offset persistence and redelivery fixes

- Offset now persisted to `poller.offset.json` alongside the lock file; survives
  process restarts and prevents reprocessing old updates on plugin reload.
- Process-level dedupe set (`Symbol.for("opencode-telegram-notify/seen-updates")`)
  ignores already-seen `update_id` values within the same process lifetime.
- Offset is advanced **only after** successful `dispatch()` and persisted
  immediately; on `getUpdates` failure (non-409) the offset is not advanced and
  the same offset is retried next cycle.
- New test coverage: offset persistence across restarts, in-process dedupe on
  redelivery, and proper offset advancement ordering.

## 0.2.1 — (internal) offset advancement fix

## 0.2.0 — dual v1/v2 support and npm distribution

- One package, two entry points sharing the same core:
  - `.` — OpenCode v2 default export `{id, setup}` (unchanged);
  - `./legacy` — OpenCode v1 hooks factory, usable as
    `@hamzaabili/opencode-telegram-notify/legacy` in the v1 `"plugin"` config.
- v1 event mapping: `permission.updated` (pre-rework:
  `{id, sessionID, title, metadata}`) and `permission.asked` (post-rework
  v1.x: `{id, sessionID, permission, patterns, metadata, always, tool?}`)
  both map to the shared asked-envelope; `permission.replied` accepts both
  `{permissionID, response}` and `{requestID, reply}` field generations;
  `session.created/updated/deleted` with a title ledger that only forwards
  real changes; `session.status` → activity; `session.idle` → completion;
  `session.error` → failure, with `MessageAbortedError` mapped to the
  *silent* interruption notice.
- Permissions on v1 are answered through the legacy surface
  `POST /session/{id}/permissions/{permissionID}` body `{ response }`, with
  an automatic fallback to the modern `permission.reply({requestID, reply})`
  client namespace when the host exposes it (the fallback is logged).
- `TELEGRAM_LANGUAGE` environment fallback (v1 has no per-plugin options);
  explicit options keep precedence.
- Poller heartbeat and idle timers are unref'ed so the plugin can never keep
  a server process alive on v1 hosts, which expose no dispose chain.
- npm distribution as the scoped package `@hamzaabili/opencode-telegram-notify`
  (the unscoped name is occupied by an unrelated project) and free CI/CD:
  `release.yml` (tag → typecheck/tests → GitHub Release → optional
  `NPM_TOKEN`-based npm publish) plus Dependabot.
- v1 host test hooks: mapper (both permission generations), client shim
  (legacy + modern surfaces incl. fallback), bounded queue, and disabled-path
  factory tested — 72 tests across 7 files.

## 0.1.0 — first public release

- v2-native plugin contract: `export default { id, setup }`, zero runtime
  dependencies (plain `fetch`).
- Permission notifications with tap-only inline buttons (*Allow once* /
  *Always allow* / *Reject*) through `client.permission.reply`
  (`decision`, with logged fallback to the legacy `reply` key shape).
- Question (`form.created`) notify-only messages with fields and options;
  auto-close on `form.replied` / `form.cancelled` ("answered"/"cancelled").
- Lifecycle notifications: completion (debounced by activity),
  failure with error type/message, silent cancellation.
- Chat bindings and allowlists: `telegram.chatId`, optional
  `telegram.allowedUserIds`; unknown chats ignored.
- Bot command menu via `setMyCommands`: `/start`, `/status`, `/setup`,
  `/stop`, `/help`; unknown commands get help, plain text ignored.
- `/setup` reply with copy-paste `opencode.jsonc` snippet and env hints.
- Safety: single-poller file lock (pid + heartbeat), ownership gate on
  `location.directory`, process-level event-id dedupe (Symbol.for set, capped),
  subagent sessions excluded from lifecycle noise, stale-button toasts.
- Privacy: `hideCommands` option, token redaction in errors/`logFile`,
  `${VAR}`-based secrets, optional append-only `logFile`.
- i18n: English and Italian.
- Test suite (bun): config, formatting, router, callbacks, lock, telegram
  client — `bun run ci`.
