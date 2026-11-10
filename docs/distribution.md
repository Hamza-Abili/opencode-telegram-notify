# Distribution notes

Prepared submission payloads. Both directories are curated; submit only when
the project has real usage.

## opencode.cafe

Submission page: <https://opencode.cafe/submit> (Clerk login required).

| Field | Value |
| --- | --- |
| Type | `plugin` |
| Product ID | `@hamzaabili/opencode-telegram-notify` |
| Display name | `OpenCode Telegram Notify` |
| Repository | `https://github.com/Hamza-Abili/opencode-telegram-notify` |
| Homepage | `https://www.npmjs.com/package/@hamzaabili/opencode-telegram-notify` |
| Tags | `telegram, notifications, permissions, chatops, mobile, v1, v2` |

Description:

> Telegram notifications for OpenCode V1 and V2: permission prompts with
> tap-only inline buttons (never auto-approve), idle and task lifecycle, and
> errors. Questions are V2-only; V1 has no form flow. Zero runtime
> dependencies.

Installation:

```sh
opencode plugin add @hamzaabili/opencode-telegram-notify@0.5.2
```

Configuration requires a BotFather token and a numeric chat id; both are
stored in the OpenCode config, not in this repository.

## awesome-opencode

Guidelines: <https://github.com/awesome-opencode/awesome-opencode/blob/main/contributing.md>

**Eligibility gate:** at least 30 days old and at least 25 stars. Check both
before submitting.

File: `data/plugins/opencode-telegram-notify.yaml`

```yaml
name: OpenCode Telegram Notify
repo: https://github.com/Hamza-Abili/opencode-telegram-notify
tagline: Telegram approvals and lifecycle notifications for OpenCode V1/V2.
description: >-
  Sends permission prompts, idle/task lifecycle events and errors to Telegram.
  Permission approvals use tap-only inline buttons and never auto-approve.
  Questions are V2-only. Works with OpenCode V1 and V2, zero runtime
  dependencies.
```

## OpenCode official ecosystem docs

Add one row under `## Plugins` on <https://opencode.ai/docs/ecosystem/>:

```markdown
| [opencode-telegram-notify](https://github.com/Hamza-Abili/opencode-telegram-notify) | Telegram notifications and tap-only approvals for OpenCode V1 and V2 |
```

## Tracking

```sh
npm view @hamzaabili/opencode-telegram-notify version
gh repo view Hamza-Abili/opencode-telegram-notify --json stargazerCount
gh issue list --repo Hamza-Abili/opencode-telegram-notify --state open
```
