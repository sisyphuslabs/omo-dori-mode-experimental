import { expect, test } from "bun:test";

import type { Http } from "../src/messenger/http.ts";
import { parseTelegramRef, splitForTelegram, Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

const recorder = () => {
  const texts: string[] = [];
  let id = 100;
  const http: Http = async (req) => {
    texts.push((JSON.parse(String(req.body)) as { text: string }).text);
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: { message_id: id++ } }) };
  };
  return { http, texts };
};

test("a Telegram message over 4096 characters goes out as several messages that join back to the original", async () => {
  const text = `${"a".repeat(3000)}\n${"b".repeat(1999)}`;
  const { http, texts } = recorder();
  const id = await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, text);
  expect(texts.length).toBe(2);
  expect(texts[0]).toBe(`${"a".repeat(3000)}\n`);
  expect(texts.join("")).toBe(text);
  expect(id).toBe(100);
});

test("a lane thread ref such as telegram:<chat>:<topic> resolves to chat and topic, a bare chat id passes through", () => {
  expect(parseTelegramRef("telegram:123456789:10")).toEqual({ chatId: "123456789", threadId: 10 });
  expect(parseTelegramRef("telegram:-100123/7")).toEqual({ chatId: "-100123", threadId: 7 });
  expect(parseTelegramRef("telegram:42")).toEqual({ chatId: "42" });
  expect(parseTelegramRef("42")).toEqual({ chatId: "42" });
});

test("short text is one message, and text without newlines is hard-cut without splitting a surrogate pair", async () => {
  const { http, texts } = recorder();
  await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, "hi");
  expect(texts).toEqual(["hi"]);
  const long = "x".repeat(9000);
  const parts = splitForTelegram(long);
  expect(parts.length).toBe(3);
  expect(parts.every((p) => p.length <= 4096)).toBe(true);
  const emoji = `${"x".repeat(4095)}😀tail`;
  const cut = splitForTelegram(emoji);
  expect(cut.join("")).toBe(emoji);
  expect(cut[1]?.startsWith("😀")).toBe(true);
});
