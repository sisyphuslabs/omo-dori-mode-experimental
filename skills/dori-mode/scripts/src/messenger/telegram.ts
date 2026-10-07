import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";

// Telegram rejects sendMessage text over 4096 characters; chunks join back to the exact original
export const splitForTelegram = (text: string, limit = 4096): string[] => {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit - 1) + 1;
    if (cut <= limit / 2) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
};

// lane threads are stored as telegram:<chat>:<topic> or telegram:<chat>/<topic>; a bare chat id passes through
export const parseTelegramRef = (to: string): { readonly chatId: string; readonly threadId?: number } => {
  const m = /^telegram:(-?\d+)(?:[:/](\d+))?$/.exec(to);
  if (!m?.[1]) return { chatId: to };
  return { chatId: m[1], ...(m[2] ? { threadId: Number(m[2]) } : {}) };
};

export type TgTarget = { readonly chatId: number | string; readonly threadId?: number };

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { parameters?: { retry_after?: number } }).parameters?.retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export class Telegram {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://api.telegram.org",
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await withBackoff(this.http, this.clock, { method: "POST", url: `${this.base}/bot${this.botToken}/${method}`, headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }, undefined, retryAfter);
    const body = JSON.parse(res.body || "{}") as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!body.ok) throw new MessengerError(`telegram ${method}: ${body.description ?? res.status}`, body.error_code ?? res.status);
    return body.result as T;
  }

  private where(t: TgTarget): Record<string, unknown> {
    return { chat_id: t.chatId, ...(t.threadId ? { message_thread_id: t.threadId } : {}) };
  }

  async send(t: TgTarget, text: string, rich = false): Promise<number> {
    let first: number | undefined;
    for (const chunk of splitForTelegram(guardText(text))) {
      const r = await this.call<{ message_id: number }>("sendMessage", { ...this.where(t), text: chunk, ...(rich ? { parse_mode: "HTML" } : {}) });
      first ??= r.message_id;
    }
    return first as number;
  }

  async edit(t: TgTarget, messageId: number, text: string, rich = false): Promise<void> {
    await this.call("editMessageText", { chat_id: t.chatId, message_id: messageId, text: guardText(text), ...(rich ? { parse_mode: "HTML" } : {}) });
  }

  async typing(t: TgTarget): Promise<void> {
    await this.call("sendChatAction", { ...this.where(t), action: "typing" });
  }

  async draft(t: TgTarget, draftId: number, text: string): Promise<void> {
    await this.call("sendMessageDraft", { ...this.where(t), draft_id: draftId, text: guardText(text) });
  }

  async createTopic(chatId: number | string, name: string): Promise<number> {
    const r = await this.call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name: guardText(name).slice(0, 128) });
    return r.message_thread_id;
  }

  async renameTopic(chatId: number | string, threadId: number, name: string): Promise<void> {
    await this.call("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: guardText(name).slice(0, 128) });
  }

  async closeTopic(chatId: number | string, threadId: number): Promise<void> {
    await this.call("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }

  async reopenTopic(chatId: number | string, threadId: number): Promise<void> {
    await this.call("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }
}

export const THINKING = "Thinking…";

export type DraftStream = { push(text: string): Promise<void>; finish(text: string, rich?: boolean): Promise<number> };

export const streamDraft = (tg: Telegram, clock: Clock, t: TgTarget, minIntervalMs = 800): DraftStream => {
  const draftId = Math.max(1, clock.now() % 2_000_000_000);
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending = "";
  let shown = "";
  const flush = async () => {
    if (pending === shown) return;
    await tg.draft(t, draftId, pending);
    shown = pending;
    lastAt = clock.now();
  };
  return {
    async push(text) {
      pending = text || THINKING;
      if (clock.now() - lastAt >= minIntervalMs) await flush();
    },
    async finish(text, rich = false) {
      return tg.send(t, text, rich);
    },
  };
};

export const startThinking = async (tg: Telegram, clock: Clock, t: TgTarget): Promise<DraftStream> => {
  const s = streamDraft(tg, clock, t);
  await s.push(THINKING);
  return s;
};

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const htmlTable = (head: readonly string[], rows: readonly (readonly string[])[]): string => {
  const cells = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: readonly string[]) => r.map((c, i) => escapeHtml(c.padEnd(widths[i] ?? 0))).join("  ");
  return `<pre>${[line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n")}</pre>`;
};
