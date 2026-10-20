/**
 * opencode-telegram-notify — message formatting (HTML).
 * All user- or tool-supplied values are escaped before embedding.
 */

import type { FormCreatedData, PermissionAskedData } from "./types.ts";
import type { Language } from "./config.ts";
import {
  ANSWER_IN_TERMINAL,
  ANSWER_WITH_BUTTONS,
  CANCELLED,
  COMPLETED,
  EMPTY,
  ERROR,
  FAILED,
  PERMISSION,
  PROJECT,
  QUESTION,
  SESSION,
} from "./i18n.ts";

const ELLIPSIS = "…";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
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
  sessionTitle?: (sessionID: string) => string | undefined;
}

function header(
  title: string,
  ctx: FormatContext,
  sessionID?: string,
  project?: string
): string {
  const lines = [`<b>${title}</b>`];
  const who: string[] = [];
  if (project) who.push(`${PROJECT[ctx.language]}: ${escapeHtml(project)}`);
  const st = sessionID ? ctx.sessionTitle?.(sessionID) : undefined;
  if (st) who.push(`${SESSION[ctx.language]}: ${escapeHtml(truncate(st, 80))}`);
  if (who.length > 0) lines.push(who.join(" · "));
  return lines.join("\n");
}

/** Permission request message body (buttons are added by the caller). */
export function formatPermission(data: PermissionAskedData, ctx: FormatContext): string {
  const head = header(PERMISSION[ctx.language], ctx, data.sessionID);
  const resources = ctx.hideCommands
    ? `<i>[${data.resources?.length ?? 0}]</i>`
    : bullets(data.resources ?? []);
  const body = [head, `<b>${escapeHtml(data.action)}</b>`, resources];
  return truncate(body.join("\n"), ctx.maxBody);
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
  body.push(mode === "buttons" ? ANSWER_WITH_BUTTONS[ctx.language] : ANSWER_IN_TERMINAL[ctx.language]);
  return truncate(body.join("\n"), ctx.maxBody);
}

/** Task lifecycle notifications. */
export function formatCompleted(sessionID: string, title: string | undefined, ctx: FormatContext): string {
  const body = [
    header(COMPLETED[ctx.language], ctx, sessionID),
    title ? escapeHtml(truncate(title, 120)) : EMPTY[ctx.language],
  ];
  return truncate(body.join("\n"), ctx.maxBody);
}

export function formatFailed(
  error: { type?: string; message?: string } | undefined,
  ctx: FormatContext
): string {
  const kind = error?.type ? ` <code>${escapeHtml(error.type)}</code>` : "";
  const msg = error?.message ? escapeHtml(truncate(error.message, 400)) : EMPTY[ctx.language];
  return truncate([header(FAILED[ctx.language], ctx), kind, msg].join("\n"), ctx.maxBody);
}

export function formatCancelled(sessionID: string, ctx: FormatContext): string {
  return truncate(header(CANCELLED[ctx.language], ctx, sessionID), ctx.maxBody);
}

export function formatError(message: string, ctx: FormatContext): string {
  return truncate(
    [`<b>${ERROR[ctx.language]}</b>`, escapeHtml(truncate(message, 400))].join("\n"),
    ctx.maxBody
  );
}
