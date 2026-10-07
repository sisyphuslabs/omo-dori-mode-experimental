import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";

export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|done) \\| (?!<what)\\S`);
  const hits = screen.split("\n").flatMap((l) => (grammar.test(l) ? [l.slice(l.indexOf("[REPORT]"))] : []));
  return hits.at(-1)?.replace(/["'\])\s,]+$/, "") ?? null;
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

export type SweepAct = { readonly kind: "nudged" | "posted" | "post-failed" | "no-report"; readonly lane: string; readonly detail: string };

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

export const freshnessTick = async (deps: FlowDeps, home: string): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  for (const lane of await deps.registry.open()) {
    if (statusOf(lane) !== "working" || !lane.pane) continue;
    const report = lastReportLine(await readScreen(deps.run, lane.pane, 200), lane.key);
    let current = lane;
    if (report && report !== lane.lastReport) {
      // a new [REPORT] line on the pane is the lane replying: freshness counts from here
      current = { ...current, lastReport: report, lastReplyAt: now };
      await deps.registry.write(current);
    }
    const heard = lastHeard(current);
    const silentMin = Math.round((now - heard) / 60_000);
    if (silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
      current = { ...current, lastNudgeAt: now };
      await deps.registry.write(current);
      acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent` });
    }
    const hook = deps.config.hooks.threadReply;
    if (silentMin >= deps.config.postAfterMin && hook && lane.thread !== "none" && (current.lastAutoReplyAt ?? 0) < heard) {
      if (!report) {
        acts.push({ kind: "no-report", lane: lane.key, detail: "pane has no [REPORT] line" });
        continue;
      }
      const text = `Progress (from the lane's last report): ${scrubForThread(report, home)}`;
      const r = await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      if (r.code !== 0) {
        // not recorded as posted, so the next tick retries
        acts.push({ kind: "post-failed", lane: lane.key, detail: `exit ${r.code}: ${(r.err || r.out).trim().slice(0, 160)}` });
        continue;
      }
      await deps.registry.write({ ...current, lastAutoReplyAt: now });
      acts.push({ kind: "posted", lane: lane.key, detail: text });
    }
  }
  return acts;
};
