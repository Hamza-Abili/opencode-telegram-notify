/**
 * opencode-telegram-notify — message formatting (HTML).
 * All user- or tool-supplied values are escaped before embedding.
 */

import type { Language } from "./config.ts";
import {
  ANSWER_IN_TERMINAL,
  ANSWER_WITH_BUTTONS,
  CANCELLED,
  COMPLETED,
  EMPTY,
  FAILED,
  LIMIT_BUDGET,
  LIMIT_FREE,
  LIMIT_MODEL_BUDGET,
  LIMIT_QUOTA,
  LIMIT_RATE,
  PERMISSION,
  PERMISSION_ANSWER_IN_TERMINAL,
  PROJECT,
  QUESTION,
  SESSION,
  USAGE_IN,
  USAGE_LABEL,
  USAGE_OUT,
} from "./i18n.ts";
import type { FormCreatedData, PermissionAskedData, TokenUsageInfo } from "./types.ts";

const ELLIPSIS = "…";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

/**
 * Truncate an already-escaped HTML fragment without cutting a tag or an
 * entity in half. Open tags are closed so Telegram never receives malformed
 * markup when `maxMessageChars` is small.
 */
export function truncateHtml(value: string, max: number): string {
  if (value.length <= max) return value;

  const build = (limit: number): string => {
    let out = "";
    let i = 0;
    const open: string[] = [];
    while (i < limit) {
      if (value[i] === "<") {
        const end = value.indexOf(">", i);
        if (end === -1 || end + 1 > limit) break;
        const tag = value.slice(i, end + 1);
        const name = /^<\/?([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase();
        if (name) {
          if (tag.startsWith("</")) {
            const at = open.lastIndexOf(name);
            if (at !== -1) open.splice(at, 1);
          } else if (!tag.endsWith("/>")) {
            open.push(name);
          }
        }
        out += tag;
        i = end + 1;
        continue;
      }
      if (value[i] === "&") {
        const end = value.indexOf(";", i);
        if (end === -1 || end - i > 10 || end + 1 > limit) break;
        out += value.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      out += value[i];
      i++;
    }
    out = `${out.trimEnd()}${ELLIPSIS}`;
    for (let j = open.length - 1; j >= 0; j--) out += `</${open[j]}>`;
    return out;
  };

  let limit = Math.max(1, max - ELLIPSIS.length);
  for (;;) {
    const candidate = build(limit);
    if (candidate.length <= max || limit <= 1) return candidate;
    limit = Math.max(1, limit - (candidate.length - max) - 1);
  }
}

function bullets(items: string[], max = 3): string {
  const shown = items.slice(0, max).map((s) => `<code>${escapeHtml(truncate(s, 120))}</code>`);
  if (items.length > max) shown.push(`<i>+${items.length - max}</i>`);
  return shown.join("\n");
}

export interface FormatContext {
  language: Language;
  hideCommands: boolean;
  maxBody: number;
  /** Project name (basename of the OpenCode root), shown in every header. */
  project?: string;
  sessionTitle?: (sessionID: string) => string | undefined;
}

function header(title: string, ctx: FormatContext, sessionID?: string): string {
  const lines = [`<b>${title}</b>`];
  const who: string[] = [];
  if (ctx.project) who.push(`${PROJECT[ctx.language]}: ${escapeHtml(ctx.project)}`);
  const st = sessionID ? ctx.sessionTitle?.(sessionID) : undefined;
  if (st) who.push(`${SESSION[ctx.language]}: ${escapeHtml(truncate(st, 80))}`);
  if (who.length > 0) lines.push(who.join(" · "));
  return lines.join("\n");
}

/** Permission request message body (buttons are added by the caller). */
export function formatPermission(
  data: PermissionAskedData,
  ctx: FormatContext,
  mode: "plain" | "buttons" = "plain"
): string {
  const head = header(PERMISSION[ctx.language], ctx, data.sessionID);
  const resources = ctx.hideCommands
    ? `<i>[${data.resources?.length ?? 0}]</i>`
    : bullets(data.resources ?? []);
  const body = [head, `<b>${escapeHtml(data.action)}</b>`, resources];
  if (mode === "plain") body.push("", PERMISSION_ANSWER_IN_TERMINAL[ctx.language]);
  return truncateHtml(body.join("\n"), ctx.maxBody);
}

/** Question (form) message body: notify-only in this release. */
export function formatQuestion(
  data: FormCreatedData,
  ctx: FormatContext,
  mode: "plain" | "buttons" = "plain"
): string {
  const form = data.form;
  const head = header(QUESTION[ctx.language], ctx, form.sessionID);
  const body = [head, `<b>${escapeHtml(truncate(form.title ?? "", 120))}</b>`];
  const fields = form.fields ?? [];
  for (const field of fields.slice(0, 5)) {
    const options = (field.options ?? [])
      .slice(0, 5)
      .map((o) => `  • ${escapeHtml(truncate(o.label ?? o.value, 60))}`)
      .join("\n");
    body.push(
      [
        `<b>${escapeHtml(truncate(field.title ?? field.key, 80))}</b>`,
        options.length > 0 ? options : `<i>${escapeHtml(field.type)}</i>`,
      ].join("\n")
    );
  }
  if (fields.length > 5) body.push(`<i>+${fields.length - 5}</i>`);
  body.push("");
  body.push(
    mode === "buttons" ? ANSWER_WITH_BUTTONS[ctx.language] : ANSWER_IN_TERMINAL[ctx.language]
  );
  return truncateHtml(body.join("\n"), ctx.maxBody);
}

/** Task lifecycle notifications. */
export function formatCompleted(
  sessionID: string,
  ctx: FormatContext,
  info?: { cost?: number; tokens?: TokenUsageInfo }
): string {
  const head = header(COMPLETED[ctx.language], ctx, sessionID);
  const usage = info ? formatUsage(info.tokens, info.cost, ctx.language) : undefined;
  return truncateHtml(usage ? `${head}\n${usage}` : head, ctx.maxBody);
}

/** Compact token count: 12800 → "12.8k", 3200000 → "3.2M", 950 → "950". */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 995) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/** Dollar cost with up to 4 decimals, trailing zeros trimmed: "0.042", "1.5". */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * One-line usage summary for completions, e.g.
 * "⚡ 12.8k in · 3.2k out · $0.042". Undefined when there is nothing to
 * report (no counters, or all zeros). The cost segment is dropped when it
 * rounds to zero (free tier / sub-cent sessions).
 */
export function formatUsage(
  tokens: TokenUsageInfo | undefined,
  cost: number | undefined,
  lang: Language
): string | undefined {
  // Upstream bills the prompt side as input + cache.read + cache.write and
  // the response side as output + reasoning (core/session/usage.ts).
  const input =
    Math.max(0, tokens?.input ?? 0) +
    Math.max(0, tokens?.cache?.read ?? 0) +
    Math.max(0, tokens?.cache?.write ?? 0);
  const output = Math.max(0, tokens?.output ?? 0) + Math.max(0, tokens?.reasoning ?? 0);
  const c = Math.max(0, cost ?? 0);
  if (input === 0 && output === 0 && c === 0) return undefined;
  const label = USAGE_LABEL[lang];
  // A host that reports cost but no counters gets a cost-only line; the
  // in/out segments would be misleading zeros.
  const costStr = formatCost(c);
  if (!tokens && costStr !== "0") return `${label} $${costStr}`;
  const line = `${label} ${compactTokens(input)} ${USAGE_IN[lang]} · ${compactTokens(output)} ${USAGE_OUT[lang]}`;
  return costStr === "0" ? line : `${line} · $${costStr}`;
}

/**
 * Friendly headline for failure types caused by a usage limit (OpenCode Go
 * free tier, provider quota, rate limits, Console budgets). Falls back to
 * the raw error type for anything else.
 */
function limitLabel(type: string, lang: Language): string | undefined {
  switch (type) {
    case "provider.free-limit":
      return LIMIT_FREE[lang];
    case "provider.quota":
      return LIMIT_QUOTA[lang];
    case "provider.rate-limit":
      return LIMIT_RATE[lang];
    case "provider.budget-limit":
      return LIMIT_BUDGET[lang];
    case "provider.model-budget-limit":
      return LIMIT_MODEL_BUDGET[lang];
    default:
      return undefined;
  }
}

export function formatFailed(
  error: { type?: string; message?: string } | undefined,
  ctx: FormatContext
): string {
  const label = error?.type ? limitLabel(error.type, ctx.language) : undefined;
  const kind = label ?? (error?.type ? ` <code>${escapeHtml(error.type)}</code>` : "");
  const msg = error?.message ? escapeHtml(truncate(error.message, 400)) : EMPTY[ctx.language];
  return truncateHtml([header(FAILED[ctx.language], ctx), kind, msg].join("\n"), ctx.maxBody);
}

export function formatCancelled(sessionID: string, ctx: FormatContext): string {
  return truncateHtml(header(CANCELLED[ctx.language], ctx, sessionID), ctx.maxBody);
}
