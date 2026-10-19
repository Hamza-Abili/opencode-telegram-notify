# Changelog

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
