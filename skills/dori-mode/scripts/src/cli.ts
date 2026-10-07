#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { loadConfig } from "./config.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { abandonLane, claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { adoptLane, launchLane, LaunchError } from "./launch.ts";
import { Registry, statusOf } from "./registry.ts";
import { UnsafeTextError } from "./panes.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { canLaunch } from "./routing.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { parseTelegramRef, Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence } from "./messenger/discord.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";

const USAGE = `dori <command> [options]

  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
  sync   [--write]                     registry vs live panes; read-only unless --write
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for $HERDR_PANE_ID
  object-done <key> --reason TEXT [--reason TEXT ...]
  close  <key> [--note TEXT]           close now (Done signals must read back live)
  abandon <key> --reason TEXT          close without Done checks (STARTUP_ERROR or dropped lane); worktrees are kept
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN)
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const config = await loadConfig();
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" },
  },
});
const known = new Set(["title", "brief", "done", "thread", "model", "cwd", "pane", "evidence", "reason", "note", "write", "loop", "to", "text", "edit"]);
const sepAt = rest.indexOf("--");
const unknown = (sepAt >= 0 ? rest.slice(0, sepAt) : rest).filter((a) => a.startsWith("--") && !known.has(a.slice(2).split("=")[0] ?? ""));
if (unknown.length) die(`unknown option ${unknown.map((a) => a.split("=")[0]).join(", ")}; valid: ${[...known].map((k) => `--${k}`).join(" ")}`);
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
const key = flags.positionals[0];
const loopMin = Number(opt("loop") ?? 0);

const lane = async (k: string | undefined) => {
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(process.env.HERDR_PANE_ID ?? "");
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

try {
  switch (command) {
    case "launch": {
      const r = await launchLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), model: opt("model"), cwd: opt("cwd") });
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), pane: need("pane") });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "claim-done":
      console.log(await claimDone(deps, await lane(key), need("evidence")));
      break;
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
      break;
    }
    case "close": {
      const r = await closeLane(deps, await lane(key ?? die("close needs a lane key")), opt("note") ?? "closed by the lead");
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "abandon": {
      const reason = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean).join("; ") || die("--reason is required");
      console.log(await abandonLane(deps, await lane(key ?? die("abandon needs a lane key")), reason));
      break;
    }
    case "watch":
      console.log("LANE_WATCH_READY");
      for (;;) {
        for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`])) console.log(line);
        await Bun.sleep(30_000);
      }
    case "freshness":
      await every(loopMin, async () => {
        for (const a of await freshnessTick(deps, process.env.HOME ?? "")) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
      });
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      await every(loopMin, async () => {
        for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13))) console.log(line);
      });
      break;
    }
    case "guard": {
      const state = { alerting: false };
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        for (const line of guardTick(await sampleHost(run), config.guard, state)) console.log(line);
      });
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
      const load = async () => (await sampleHost(run)).load1;
      const slot = await acquireSlot({ dir: `${config.stateDir}/heavy`, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "can-launch": {
      const v = canLaunch(await sampleHost(run), config.guard);
      console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
      process.exit(v.ok ? 0 : 4);
    }
    case "send": {
      const platform = key ?? die("send needs slack, telegram or discord");
      const to = need("to");
      const text = need("text");
      const thread = opt("thread");
      const edit = opt("edit");
      const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
      if (platform === "slack") {
        const slack = new Slack(fetchHttp, realClock, { token: token("DORI_SLACK_TOKEN"), cookie: process.env.DORI_SLACK_COOKIE }, undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
        if (edit) await slack.edit(to, edit, text);
        else console.log(`SENT ${(await slack.post(to, text, thread)).ts}`);
      } else if (platform === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
        const ref = parseTelegramRef(to);
        const threadId = thread ? Number(thread) : ref.threadId;
        const target = { chatId: ref.chatId, ...(threadId ? { threadId } : {}) };
        if (edit) await tg.edit(target, Number(edit), text);
        else {
          const sent = await tg.send(target, text).catch(async (e: unknown) => {
            // a lane ref like telegram:<chat>:<n> may name a message, not a forum topic; still reach the chat
            if (!(e instanceof MessengerError) || !/thread not found/i.test(e.message) || !target.threadId) throw e;
            console.error(`WARN topic ${target.threadId} not found in chat ${target.chatId}; sent to the chat without a topic`);
            return tg.send({ chatId: target.chatId }, text);
          });
          console.log(`SENT ${sent}`);
        }
      } else if (platform === "discord") {
        const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
        if (edit) await dc.edit(to, edit, text);
        else console.log(`SENT ${await dc.send(thread ?? to, text)}`);
      } else die(`unknown platform ${platform}`);
      break;
    }
    case "presence": {
      if (key === "slack") {
        const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
        const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
          const options: Bun.WebSocketOptions = { headers: { ...headers } };
          const ws = new WebSocket(url, options);
          return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
        }, auth);
        console.log("PRESENCE_READY slack");
        await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
      } else if (key === "discord") {
        const token = process.env.DORI_DISCORD_TOKEN ?? die("DORI_DISCORD_TOKEN is not set");
        discordPresence(() => {
          const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
          let handler: (d: string) => void = () => {};
          ws.addEventListener("message", (e) => handler(String(e.data)));
          return { send: (d) => ws.send(d), close: () => ws.close(), onMessage: (cb) => { handler = cb; } };
        }, token, realTimers);
        console.log("PRESENCE_READY discord");
        await new Promise(() => {});
      } else die("presence needs slack or discord");
      break;
    }
    case "inbound": {
      if (key !== "slack") die("inbound supports slack");
      const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE };
      const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
      const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
      const me = String((await slack.call("auth.test", {})).user_id ?? die("auth.test returned no user_id"));
      console.log("INBOUND_READY slack");
      await every(loopMin, async () => {
        for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me })) console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`);
      });
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || e instanceof UnsafeTextError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError) die(e.message);
  throw e;
}
