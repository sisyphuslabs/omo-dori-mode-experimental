import { afterEach, beforeEach, expect, test } from "bun:test";

import { abandonLane, claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after a claim the lane is closed, its thread marked done and its worktree removed", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
  expect(world.calls).toContainEqual(["notify", "chat:team/123", "Done: merged acme/app#1 abc123"]);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 6 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("a lane that failed at startup is abandoned without Done checks; its tab closes and worktrees stay", async () => {
  world.prState = "OPEN";
  const line = await abandonLane(at(T0), { ...lane, tab: "w:t3" }, "STARTUP_ERROR usage limit");
  expect(line).toStartWith("ABANDONED demo-lane");
  expect(closedVia()).toEqual([["herdr", "tab", "close", "w:t3"]]);
  expect(world.calls.some((c) => c[0] === "gh" || c.includes("remove"))).toBe(false);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(after?.history?.at(-1)?.note).toBe("abandoned: STARTUP_ERROR usage limit");
});

test("a done claim counts as the lane replying", async () => {
  await claimDone(at(T0 + MIN), lane, "merged acme/app#1");
  expect((await at(T0).registry.read("demo-lane"))?.lastReplyAt).toBe(T0 + MIN);
});

test("text still sitting in the pane input gets another Enter until it is gone", async () => {
  world.stuckReads = 1;
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] stuck text still here")).toBe(true);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(2);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});
