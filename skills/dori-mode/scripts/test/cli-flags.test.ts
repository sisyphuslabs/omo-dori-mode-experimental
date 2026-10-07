import { expect, test } from "bun:test";
import { join } from "node:path";

import { withState } from "./fakes.ts";

const cli = async (args: string[]) => {
  const s = withState();
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { env: { ...process.env, DORI_CONFIG: join(s.dir, "none.json"), DORI_STATE_DIR: s.dir }, stdout: "pipe", stderr: "pipe" });
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  s.done();
  return { code, err };
};

test("a misspelled flag is refused instead of silently ignored", async () => {
  const r = await cli(["launch", "demo", "--titel", "x"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("unknown option --titel");
});

test("flags after -- belong to the heavy child command and are not checked", async () => {
  const r = await cli(["heavy", "lbl", "--", "true", "--weird"]);
  expect(r.err).not.toContain("unknown option");
});
