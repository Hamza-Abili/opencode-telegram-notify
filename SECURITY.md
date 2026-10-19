# Security model

This document explains what the plugin sends where, what it can do, and the
choices made to keep it boring from a security standpoint.

## The one rule: tap-only, never auto

Permission notifications come with exactly three buttons (`allow` → `once`,
`always` → `always`, `reject` → `reject`). The plugin:

- never answers a permission by itself;
- never sends free text into OpenCode (no reply→prompt injection channel);
- never edits configuration by itself.

Everything else (questions, completions, failures) is read-only notification.

## Data flow

| Data | Direction | Notes |
| --- | --- | --- |
| Event envelopes (`permission.asked`, `form.created`, …) | OpenCode → plugin → Telegram | only events whose `location.directory` resolves to this project root are considered |
| Button taps | Telegram → plugin → OpenCode | via `client.permission.reply`; only for requests this activation asked you about |
| Bot token | OpenCode → api.telegram.org | never written to disk unredacted, never in logs |
| Chat + user allowlists | Telegram → plugin | `chatId` binding + optional `allowedUserIds` gate |

What is **not** sent: file contents, your OpenCode API keys, secrets from
`.env` files, environment values other than the two `{VAR}` placeholders you
configure yourself.

## Access control

- The bot only serves the chat bound by `telegram.chatId`; other chats' updates
  are ignored entirely (they are not even routed).
- `telegram.allowedUserIds` (recommended when the bot could be reached by
  several people) additionally restricts who may tap buttons or run commands:
  taps and commands from other users are dropped before any state change.
- Buttons embed only which earlier message they belong to: there is no
  `sessionID`/`requestID` in Telegram callback data, so a tap cannot target a
  permission the plugin never surfaced in your chat.
- Stale buttons (older activation) resolve to "outdated" toasts instead of
  replies to unknown requests.

## Telegram-specific hard surface

- `getUpdates` single-consumer rule: a lockfile with pid+heartbeat in the user
  cache dir elects one poller per host; other instances stand by.
- All bot API calls have timeouts, bounded retries and 429 handling; poller
  failures never crash OpenCode.
- Long polling is inbound-outbound only: **no inbound port is opened** on your
  machine. The plugin initiates all HTTPS connections.

## Secret handling

- `botToken`/`chatId` accept `${VAR}` expansion; keep real values out of
  `opencode.jsonc` (it is a dotfile often synced to repos).
- `TelegramError` messages and every log line are passed through a redactor
  that strips the token and its numeric prefix.
- `logFile` output is token-redacted; the log records event ids and failures,
  not message bodies.
- This repo contains no `.env`, no tokens, and tests use fake tokens.

## Trust assumptions (be honest with yourself)

- Whoever controls the Telegram chat can approve permissions. That is the
  point. If your chat is compromised, approval authority is compromised — use
  a dedicated bot, keep `allowedUserIds` on, and prefer "Allow once".
- OpenCode permission model still applies server-side: the plugin only casts
  votes on requests OpenCode itself raised.
