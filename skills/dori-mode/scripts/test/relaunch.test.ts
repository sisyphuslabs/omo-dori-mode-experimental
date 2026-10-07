import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { adoptLane, launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const HEADING = "## Lane footer (written by dori launch)";
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const withTabs = (deps: FlowDeps, n: number): FlowDeps => ({
  ...deps,
  run: async (argv, o) => (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { tab_id: `w:t${n}`, root_pane: { pane_id: `w:p${n}` } } }), err: "" } : deps.run(argv, o)),
});

const closed: Lane = { key: "re-lane", title: "re", thread: "none", pane: "w:p1", brief: "/b.md", done: "file /x", openedAt: new Date(T0).toISOString(), closedAt: new Date(T0 + MIN).toISOString(), status: "closed" };

test("relaunching a closed key archives the old record and leaves exactly one footer naming the new key", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, `TASK: do it\n\n${HEADING}\n- Key: old-a.\n\n${HEADING}\n- Key: old-b.\n`);
  await deps.registry.write(closed);
  const r = await launchLane(withTabs(deps, 2), { key: "re-lane", title: "re", brief, done: "file /x" });
  expect(r.lane.pane).toBe("w:p2");
  const text = await Bun.file(brief).text();
  expect(text.split(HEADING).length - 1).toBe(1);
  expect(text).toStartWith("TASK: do it\n");
  expect(text).toContain("- Key: re-lane.");
  expect(text).not.toContain("old-a");
  expect((await deps.registry.read("re-lane"))?.closedAt).toBeUndefined();
  const archived = readdirSync(join(state.dir, "lanes", "archive"));
  expect(archived).toHaveLength(1);
  expect(archived[0]).toStartWith("re-lane.");
  expect((await deps.registry.list()).map((l) => l.key)).toEqual(["re-lane"]);
});

test("an open lane's key is still refused, and nothing is archived", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const { closedAt: _c, status: _s, ...open } = closed;
  await deps.registry.write(open);
  await expect(adoptLane(deps, { key: "re-lane", title: "x", brief: "/b.md", done: "file /x", pane: "w:p3" })).rejects.toThrow("already registered");
  expect(existsSync(join(state.dir, "lanes", "archive"))).toBe(false);
});

test("a failed thread post is reported as post-failed, not recorded, and retried on the next tick", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify-broken", "{thread}", "{text}"] } });
  const report = "[REPORT] quiet-lane | milestone | step one done";
  await deps(T0).registry.write({ key: "quiet-lane", title: "q", thread: "chat:1", pane: "w:p7", brief: "/b.md", done: "file /x", openedAt: new Date(T0).toISOString(), lastReplyAt: T0, lastReport: report, lastNudgeAt: T0 + MIN });
  world.screen = `${report}\n❯ `;
  const first = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  expect(first.map((a) => a.kind)).toEqual(["post-failed"]);
  expect(first[0]?.detail).toStartWith("exit 1");
  expect((await deps(T0).registry.read("quiet-lane"))?.lastAutoReplyAt).toBeUndefined();
  expect((await freshnessTick(deps(T0 + 26 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["post-failed"]);
});
