import { describe, expect, test } from "bun:test";
import { LaunchError, launchLane, validateLaunch } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

describe("launch model validation", () => {
  test("rejects with LaunchError when model is provided but agentCommand lacks {model}", async () => {
    const state = withState();
    try {
      const w = newWorld();
      const clock = fakeClock(1_000);
      const deps = depsFor(w, clock, state.dir, { agentCommand: ["omo", "{prompt}"] });

      await expect(
        launchLane(deps, {
          key: "demo",
          title: "t",
          brief: "/nonexistent",
          done: "file /x",
          model: "m",
        }),
      ).rejects.toThrow(LaunchError);

      await expect(
        launchLane(deps, {
          key: "demo",
          title: "t",
          brief: "/nonexistent",
          done: "file /x",
          model: "m",
        }),
      ).rejects.toThrow(/\{model\}/);

      expect(w.calls.some((c) => c[0] === "herdr")).toBe(false);
    } finally {
      state.done();
    }
  });

  test("resolves validateLaunch when model is not provided and agentCommand lacks {model}", async () => {
    const state = withState();
    try {
      const w = newWorld();
      const clock = fakeClock(1_000);
      const deps = depsFor(w, clock, state.dir, { agentCommand: ["omo", "{prompt}"] });

      await expect(
        validateLaunch(deps, {
          key: "demo",
          title: "t",
          brief: "/nonexistent",
          done: "file /x",
        }),
      ).resolves.toBeUndefined();
    } finally {
      state.done();
    }
  });
});
