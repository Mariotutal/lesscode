import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreFiles, snapshotFiles } from "../src/plan/snapshot.js";

describe("LES-29 shared snapshot/restore", () => {
  it("restores changed contents, recreates parent dirs, and removes files that were absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-snap-"));
    mkdirSync(join(dir, "src/deep"), { recursive: true });
    writeFileSync(join(dir, "src/deep/a.ts"), "original\n");
    const snaps = snapshotFiles(dir, ["src/deep/a.ts", "src/new.ts"]);
    writeFileSync(join(dir, "src/deep/a.ts"), "changed\n");
    writeFileSync(join(dir, "src/new.ts"), "created\n");
    restoreFiles(dir, snaps);
    expect(readFileSync(join(dir, "src/deep/a.ts"), "utf8")).toBe("original\n");
    expect(existsSync(join(dir, "src/new.ts"))).toBe(false);
  });
});
