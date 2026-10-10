import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, watchTick } from "../src/done-flow.ts";
import { adoptLane, LaunchError } from "../src/launch.ts";
import type { Http } from "../src/messenger/http.ts";
import { statusOf } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { checkDone, checkSignal, doneSyntaxErrors, splitDone } from "../src/signals.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const state = withState();
afterAll(() => state.done());
const io = { cwd: state.dir, home: "/nonexistent-home" };

test("a command signal passes on exit 0 and runs the argv directly, so shell syntax stays literal", async () => {
  const ok = await checkSignal('command ["sh","-c","exit 0"]', run, io);
  expect(ok).toMatchObject({ ok: true, detail: "exit 0" });
  const literal = await checkSignal('command ["echo","$(id); rm -rf /"]', run, io);
  expect(literal).toMatchObject({ ok: true });
  const out = await checkSignal('command ["echo","$(id); rm -rf /"] stdout~"^\\\\$\\\\(id\\\\); rm -rf /$"', run, io);
  expect(out.ok).toBe(true);
});

test("a command signal fails on a non-zero exit, a missing program, or stdout that does not match", async () => {
  expect(await checkSignal('command ["sh","-c","echo broken >&2; exit 3"]', run, io)).toMatchObject({ ok: false, detail: "exit 3: broken" });
  expect((await checkSignal('command ["no-such-program-xyz"]', run, io)).ok).toBe(false);
  const mismatch = await checkSignal('command ["echo","3 failed"] stdout~"0 failed"', run, io);
  expect(mismatch.ok).toBe(false);
  expect(mismatch.detail).toStartWith("exit 0 but stdout does not match");
});

test("a command signal runs in the lane's directory", async () => {
  writeFileSync(join(state.dir, "marker.txt"), "here");
  expect((await checkSignal('command ["cat","marker.txt"] stdout~"here"', run, io)).ok).toBe(true);
});

test("a file signal checks existence, then sha256, then a JSON field, and says which one failed", async () => {
  const f = join(state.dir, "result.json");
  const content = JSON.stringify({ build: { status: "ok", tests: 41 }, list: ["a", "b"] });
  writeFileSync(f, content);
  const sha = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  expect((await checkSignal(`file ${f}`, run, io)).ok).toBe(true);
  expect((await checkSignal(`file result.json sha256=${sha}`, run, io)).ok).toBe(true);
  expect((await checkSignal('file result.json json:.build.status="ok"', run, io)).ok).toBe(true);
  expect((await checkSignal('file result.json json:.list.1="b"', run, io)).ok).toBe(true);
  expect(await checkSignal("file missing.json", run, io)).toMatchObject({ ok: false, detail: `missing: ${join(state.dir, "missing.json")}` });
  expect((await checkSignal(`file result.json sha256=${"0".repeat(64)}`, run, io)).detail).toStartWith("sha256");
  expect(await checkSignal("file result.json json:.build.tests=40", run, io)).toMatchObject({ ok: false, detail: ".build.tests is 41, want 40" });
  expect(await checkSignal('file result.json json:.build.owner="x"', run, io)).toMatchObject({ ok: false, detail: "no field .build.owner" });
});

test("a file signal does not take a string for a number: json values compare as JSON", async () => {
  writeFileSync(join(state.dir, "n.json"), JSON.stringify({ n: 3 }));
  expect((await checkSignal('file n.json json:.n="3"', run, io)).ok).toBe(false);
  expect((await checkSignal("file n.json json:.n=3", run, io)).ok).toBe(true);
});

test("a url signal checks the status and the body, and a network failure is a failed check, not a crash", async () => {
  const http: Http = async (req) => {
    if (req.url.includes("down")) throw new Error("ECONNREFUSED");
    if (req.url.endsWith("/health")) return { status: 200, headers: {}, body: '{"status":"ready"}' };
    return { status: 404, headers: {}, body: "not found" };
  };
  const web = { ...io, http };
  expect((await checkSignal('url http://localhost:3000/health body~"\\"ready\\""', run, web)).ok).toBe(true);
  expect(await checkSignal("url http://localhost:3000/other", run, web)).toMatchObject({ ok: false, detail: "status 404, want 200" });
  expect((await checkSignal("url http://localhost:3000/other status=404", run, web)).ok).toBe(true);
  expect((await checkSignal('url http://localhost:3000/health body~"starting"', run, web)).ok).toBe(false);
  expect((await checkSignal("url http://down.invalid/", run, web)).detail).toStartWith("request failed");
});

test("signals are split on top-level semicolons only, so a semicolon inside an argv or regex stays put", () => {
  expect(splitDone('Done = command ["sh","-c","a; b"]; file out.txt; closed acme/app#2')).toEqual(['command ["sh","-c","a; b"]', "file out.txt", "closed acme/app#2"]);
});

test("a Done line with a malformed signal is refused at launch, with the reason", async () => {
  const deps = depsFor(newWorld(), fakeClock(0), state.dir);
  const bad = ["two clean QA passes", "command bun test", 'command ["bun", 3]', "file x.json sha256=abc", "url ftp://host", 'command ["x"] stdout="y"', "file a.json json:.v~1"];
  for (const done of bad) expect(doneSyntaxErrors(done)).toHaveLength(1);
  await expect(adoptLane(deps, { key: "qa-lane", title: "qa", brief: "/b.md", done: "command bun test", pane: "w:p9" })).rejects.toBeInstanceOf(LaunchError);
  const lane = await adoptLane(deps, { key: "qa-lane", title: "qa", brief: "/b.md", done: 'command ["bun","test"] stdout~"0 fail"; file ~/qa/report.json json:.passed=true; url http://localhost:3000/health', pane: "w:p9" });
  expect(lane.done).toContain("command");
});

test("a QA-only lane's claim is re-checked at close time: the lane says done, but the command still fails, so it stays open", async () => {
  const world = newWorld();
  const clock = fakeClock(Date.parse("2026-01-01T00:00:00Z"));
  const deps = { ...depsFor(world, clock, state.dir), run, signalIo: { cwd: state.dir } };
  const lane = await adoptLane(deps, { key: "local-setup", title: "setup", brief: "/b.md", done: `command ["bun","test"]`, pane: "w:p3", cwd: state.dir });
  await claimDone(deps, lane, "I ran the setup and it works");
  clock.at += 6 * 60_000;
  await watchTick(deps);
  const after = await deps.registry.read("local-setup");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons[0]).toContain("exit 1");
});

test("checkDone reports every signal, so one passing signal never hides a failing one", async () => {
  writeFileSync(join(state.dir, "ok.txt"), "x");
  const checks = await checkDone('file ok.txt; command ["false"]', run, io);
  expect(checks.map((c) => c.ok)).toEqual([true, false]);
});
