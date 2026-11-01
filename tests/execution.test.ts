import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerExecutor, createTrustedLocalExecutor } from "../src/execution/index.js";

const temporary: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "lc-execution-test-")); temporary.push(path); return path; };
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("repository execution", () => {
  it("does not pass application credentials or Node loader hooks to repository commands, including sync config discovery", async () => {
    const original = process.env.LESSCODE_TEST_SECRET;
    process.env.LESSCODE_TEST_SECRET = "only-the-control-process-may-see-this";
    const executor = createTrustedLocalExecutor();
    try {
      const command = { repoDir: directory(), command: process.execPath, args: ["-e", "console.log(JSON.stringify({secret:process.env.LESSCODE_TEST_SECRET,home:process.env.HOME,ci:process.env.CI}))"] };
      for (const result of [await executor.run(command), executor.runSync(command)]) {
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ ci: "1" });
        expect(JSON.parse(result.stdout).secret).toBeUndefined();
        expect(JSON.parse(result.stdout).home).not.toBe(process.env.HOME);
      }
    } finally {
      if (original === undefined) delete process.env.LESSCODE_TEST_SECRET; else process.env.LESSCODE_TEST_SECRET = original;
      await executor.dispose();
    }
  });

  it("preserves arguments as data instead of interpreting shell syntax", async () => {
    const dir = directory();
    const marker = join(dir, "should-not-exist");
    const value = `tests; touch ${marker}; $(touch ${marker})`;
    const executor = createTrustedLocalExecutor();
    try {
      const result = await executor.run({ repoDir: dir, command: process.execPath, args: ["-e", "console.log(process.argv[1])", value] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(value);
      expect(existsSync(marker)).toBe(false);
    } finally { await executor.dispose(); }
  });

  it("bounds output and synchronous executable config evaluation", async () => {
    const executor = createTrustedLocalExecutor();
    const repoDir = directory();
    try {
      const output = await executor.run({ repoDir, command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100000))"], maxOutputBytes: 256 });
      expect(output.exitCode).toBeNull();
      expect(output.error).toMatch(/output exceeded/);
      expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(256);
      const hung = executor.runSync({ repoDir, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 100 });
      expect(hung.timedOut).toBe(true);
      expect(hung.exitCode).toBeNull();
    } finally { await executor.dispose(); }
  });

  it("kills a timed-out repository process and its descendants", async () => {
    const dir = directory();
    const marker = join(dir, "orphan-wrote-this");
    const child = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1000)`;
    const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const executor = createTrustedLocalExecutor();
    try {
      const result = await executor.run({ repoDir: dir, command: process.execPath, args: ["-e", program], timeoutMs: 150 });
      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(existsSync(marker)).toBe(false);
    } finally { await executor.dispose(); }
  });

  it("supports cancellation without waiting for the full command timeout", async () => {
    const executor = createTrustedLocalExecutor();
    const controller = new AbortController();
    try {
      const pending = executor.run({ repoDir: directory(), command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], signal: controller.signal, timeoutMs: 30_000 });
      controller.abort();
      expect((await pending).error).toMatch(/aborted/);
    } finally { await executor.dispose(); }
  });
});

function fakeDocker() {
  const dir = directory();
  const log = join(dir, "docker-calls.jsonl");
  const runtime = join(dir, "docker");
  writeFileSync(runtime, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='image')console.log('sha256:'+'a'.repeat(64));\n`);
  chmodSync(runtime, 0o755);
  return { runtime, calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) };
}

describe("isolated execution contract", () => {
  it("prepares dependencies without lifecycle scripts, verifies offline, and removes containers and volumes", async () => {
    const repoDir = directory();
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    const fake = fakeDocker();
    const executor = createDockerExecutor({ image: "operator/runner@sha256:fixed", runtime: fake.runtime });
    await executor.prepare(repoDir);
    const run = await executor.run({ repoDir, command: "npm", args: ["test", "--", "tests"] });
    const config = executor.runSync({ repoDir, command: "./node_modules/.bin/eslint", args: ["--print-config", "src/a.ts"] });
    expect(run.exitCode).toBe(0);
    expect(config.exitCode).toBe(0);
    await executor.dispose();
    const calls = fake.calls();
    const install = calls.find((args) => args.includes("install"))!;
    expect(install).toContain("--ignore-scripts");
    expect(install).toContain("--package-lock=false");
    expect(install[install.indexOf("--network") + 1]).toBe("bridge");
    for (const command of calls.filter((args) => args.includes("test") || args.includes("--print-config"))) {
      expect(command[command.indexOf("--network") + 1]).toBe("none");
      expect(command).toContain("no-new-privileges");
      expect(command).toContain("--read-only");
      expect(command).toContain("never");
      expect(command.join(" ")).not.toContain("META_API_KEY");
      expect(command.join(" ")).not.toContain("docker.sock");
    }
    expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(true);
  });

  it("refuses writable host dependency symlinks and never falls back when Docker is unavailable", async () => {
    const repoDir = directory();
    symlinkSync(directory(), join(repoDir, "node_modules"));
    const executor = createDockerExecutor({ image: "operator/runner:fixed", runtime: "/does-not-exist/docker" });
    await expect(executor.prepare(repoDir)).rejects.toThrow(/node_modules symlink/);
    const clean = directory();
    await expect(executor.prepare(clean)).rejects.toThrow(/runner image inspection failed/);
    expect(() => executor.runSync({ repoDir: clean, command: "node", args: ["-e", "process.exit(0)"] })).toThrow(/not prepared/);
    await executor.dispose();
  });
});
