import { existsSync } from "node:fs";

import { type DoriConfig, fill } from "./config.ts";
import { type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import { sendVerified } from "./panes.ts";
import { checkDone, type SignalIo } from "./signals.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
};

const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false }, lastReplyAt: deps.clock.now() }));
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically at ${closesAt}Z (${deps.config.closeAfterMin} minutes) unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}`;
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  if (lane.pane) await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  for (const wt of await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])) {
    if (!exists(wt)) continue;
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};

export const closeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  const cleanup: string[] = [];
  const hook = deps.config.hooks.threadDone;
  if (hook && lane.thread !== "none") {
    const r = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
    cleanup.push(r.code === 0 ? "thread marked done" : `thread hook failed: ${r.err.slice(0, 160)}`);
  }
  if (lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  else if (lane.pane) cleanup.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  const root = lane.cwd ?? deps.config.defaultCwd;
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const receipt = { checks, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

// for lanes that never got going (STARTUP_ERROR) or were dropped: no Done check, worktrees kept for inspection
export const abandonLane = async (deps: FlowDeps, lane: Lane, reason: string): Promise<string> => {
  const cleanup: string[] = [];
  if (lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  else if (lane.pane) cleanup.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  const at = iso(deps.clock);
  const receipt = { abandoned: true, note: reason, cleanup };
  await deps.registry.write(withStatus(lane, "closed", `abandoned: ${reason}`, at, { closedAt: at, receipt }));
  return `ABANDONED ${lane.key} ${JSON.stringify(receipt)}`;
};

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return objectDone(deps, lane, blocked);
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return objectDone(deps, lane, failing);
  const verified = withStatus(lane, "verified-done", "Done signals read back live", iso(deps.clock));
  await deps.registry.write(verified);
  const result = await closeLane(deps, verified, `Done: ${evidence}`);
  if (!result.closed) return objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, result.lines.filter((l) => l.startsWith("SIGNAL NOT")));
  return `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`;
};

export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const listed of await deps.registry.list()) {
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    let lane = listed;
    const claim = listed.claim;
    if (!claim.emitted) {
      out.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`);
      lane = { ...lane, claim: { ...claim, emitted: true } };
      await deps.registry.write(lane);
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    out.push(await settle(deps, lane, claim.evidence));
  }
  return out;
};
