import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deadPaneTick } from "../src/dead-panes.ts";
import { freshnessTick } from "../src/freshness.ts";
import { acquireSlot, releaseSlot } from "../src/heavy-slot.ts";
import { guardTick } from "../src/host-guard.ts";
import { adoptLane, LaunchError } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "quiet-lane", title: "quiet", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("a lane silent past the nudge time is nudged once, then its last report is posted for it", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n❯ ";
  await deps(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open" });
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const posted = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  expect(posted.map((a) => a.kind)).toEqual(["posted"]);
  const call = world.calls.find((c) => c[0] === "notify");
  expect(call?.[1]).toBe("chat:team/9");
  expect(call?.[2]).toContain("tests green on ~/repo, PR open");
  expect(sent(world)).toHaveLength(1);
});

test("a new report line on the pane records lastReplyAt and resets the silence clock", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(working);
  world.screen = "[REPORT] quiet-lane | milestone | step one done\n❯ ";
  expect(await freshnessTick(deps(T0 + 14 * MIN), "/home/test")).toEqual([]);
  expect((await deps(T0).registry.read("quiet-lane"))?.lastReplyAt).toBe(T0 + 14 * MIN);
  expect(await freshnessTick(deps(T0 + 20 * MIN), "/home/test")).toEqual([]);
  expect((await deps(T0).registry.read("quiet-lane"))?.lastReplyAt).toBe(T0 + 14 * MIN);
  expect((await freshnessTick(deps(T0 + 30 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
});

test("a stopped agent pane is reported once per hour and the lead pane is never reported", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }, { pane_id: "lead:p1", workspace_id: "lead" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12")).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12")).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T13")).toEqual(["DEAD_PANE w:p1"]);
});

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot({ ...base, alive: (pid) => pid !== 999999, clock: { ...clock, sleep: async () => { polls++; } } }, "test");
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { polls++; if (polls > 2) throw new Error("stop"); } };
  await expect(acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1)).rejects.toThrow("stop");
});

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" })).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" });
  expect(ok.thread).toBe("none");
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" })).rejects.toThrow("already registered");
});

test("the session id is read from --session, then a child's environment, then the session file made at start", async () => {
  const info = JSON.stringify({ result: { process_info: { shell_pid: 10 } } });
  const fake = (extra: Record<string, string>) => async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.startsWith("herdr pane process-info")) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };
  const table = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin" }, { pid: 12, ppid: 11, cmd: "bun /x/mcp/cli.js mcp" }];
  const flagged = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" }];
  expect((await resolveSession("w:p1", "/repo", flagged, { run: fake({}), sessionsDir: "/s" })).via).toBe("argv");
  expect((await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww -o command= -p 12": "bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf X=1" }), sessionsDir: "/s" })).id).toBe("01a11440-ee81-7f90-b2ed-dcc7d51a0adf");
  const listDir = () => ["2026-01-01T09-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl", "2026-01-01T12-00-02-113Z_01a11440-ee81-7f90-b2ed-dcc7d51a0adf.jsonl"];
  const byStart = await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww": "bun mcp X=1", "ps -o lstart=": "Thu Jan  1 12:00:01 2026 GMT" }), sessionsDir: "/s", listDir });
  expect(byStart).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "start-time", pid: 11 });
});
