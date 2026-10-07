import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry";

describe("Registry", () => {
  test("list() and open() tolerate malformed lane JSON file", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "registry-test-"));
    try {
      const registry = new Registry(stateDir);
      await registry.write({
        key: "good",
        title: "t",
        thread: "none",
        brief: "b",
        done: "file /x",
        openedAt: new Date().toISOString(),
      });

      writeFileSync(join(stateDir, "lanes", "broken.json"), "{");

      const listResult = await registry.list();
      expect(listResult).toHaveLength(1);
      expect(listResult[0]!.key).toBe("good");

      const openResult = await registry.open();
      expect(openResult).toHaveLength(1);
      expect(openResult[0]!.key).toBe("good");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
