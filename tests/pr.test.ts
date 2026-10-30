import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { simplify } from "../src/simplify/simplify.js";
import { PR_DECLARATION_FILE, gateCheck, readPrDeclaration, runPrSimplifyCheck } from "../src/pr/index.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Scripted model (same stub shape as tests/tool.test.ts): one stub
 * serves both Spark (report_findings) and Wonder
 * (propose_surgical_patch / repair_patch), dispatching on the tool
 * name. No live model, no sealed reads.
 */
function scripted(sparkFindings: unknown, wonderEdits: unknown): GuestClient {
  return {
    config: { baseUrl: "stub", apiKey: "stub", model: "scripted" },
    async chat(req) {
      const tool = req.tools?.[0]?.function.name ?? "";
      const payload = tool === "report_findings" ? { findings: sparkFindings } : { edits: wonderEdits };
      return {
        content: null,
        toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(payload) } }],
        finishReason: "tool_calls",
      };
    },
  } as GuestClient;
}

/**
 * Materialize a fixture as a local pull-request fixture: the fixture
 * repo (branches base, bloated-pr) with the PR's declared
 * lesscode-pr.json written into the PR checkout. The declaration is
 * uncommitted on purpose: the caller must not modify the branch, and
 * the test asserts it does not.
 */
async function materializePr(n: string, declaration: unknown): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `lc-pr-${n}-`));
  const dir = join(tmp, "f");
  await sh(root, "bash", ["fixtures/scripts/materialize.sh", n, dir]);
  await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
  await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
  if (declaration !== undefined) writeFileSync(join(dir, PR_DECLARATION_FILE), JSON.stringify(declaration));
  return dir;
}

const cite = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });

describe("pull-request simplify check", () => {
  it("resolves checkout, base, and intent from the PR's declared lesscode-pr.json", async () => {
    const dir = await materializePr("2", { baseRef: "base", intent: ["src/checkout/checkout.ts"] });
    expect(readPrDeclaration(dir)).toEqual({ baseRef: "base", intent: ["src/checkout/checkout.ts"] });
  }, 300_000);

  it("rejects a missing or invalid declaration before any run", async () => {
    const missing = await materializePr("2", undefined);
    expect(() => readPrDeclaration(missing)).toThrow(/cannot read/);
    const bad = await materializePr("2", { baseRef: "base", intent: [] });
    expect(() => readPrDeclaration(bad)).toThrow(/invalid/);
    await expect(runPrSimplifyCheck({ checkout: bad })).rejects.toThrow(/invalid/);
  }, 300_000);

  it("accepted: the PR check is the gate result of calling simplify directly, and the branch is untouched", async () => {
    const intent = ["src/checkout/checkout.ts", "src/checkout/formatMoney.ts"];
    const dir = await materializePr("2", { baseRef: "base", intent });
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const statusBefore = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;

    const spark = [
      { category: "duplicate-helper", file: "src/checkout/formatMoney.ts", existingHelperFile: "src/lib/formatMoney.ts", citations: [cite("src/checkout/formatMoney.ts", 1, 8), cite("src/lib/formatMoney.ts", 1, 8)], rationale: "duplicate" },
    ];
    const newCheckout = [
      'import { formatMoney } from "../lib/formatMoney.js";',
      "export interface LineItem { price: number; qty: number; }",
      "export function checkoutTotal(items: LineItem[]): string {",
      "  return formatMoney(items.reduce((sum, i) => sum + i.price * i.qty, 0));",
      "}",
      "",
    ].join("\n");
    const wonder = [
      { findingIndex: 0, action: "retarget", newFiles: [{ file: "src/checkout/checkout.ts", content: newCheckout }], deleteFiles: ["src/checkout/formatMoney.ts"], rationale: "retarget" },
    ];
    const client = scripted(spark, wonder);

    const viaPr = await runPrSimplifyCheck({ checkout: dir, sparkClient: client, wonderClient: client });
    const direct = await simplify({ checkout: dir, base: "base", intent, sparkClient: client, wonderClient: client });

    // Same verdict and gate result as calling simplify directly.
    expect(viaPr.result).toEqual(direct);
    expect(viaPr.result.verdict).toBe("accepted");
    expect(viaPr.result.gate?.accepted).toBe(true);
    expect(viaPr.result.patch).toContain("../lib/formatMoney.js");

    // The check body is that gate result; the conclusion comes from the gate alone.
    expect(viaPr.check).toEqual(gateCheck(direct));
    expect(viaPr.check.name).toBe("lesscode/simplify");
    expect(viaPr.check.conclusion).toBe("success");
    expect(viaPr.check.body).toBe(JSON.stringify(direct.gate));
    expect(JSON.parse(viaPr.check.body)).toEqual(direct.gate);

    // The caller does not apply the patch and does not modify the PR branch.
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect((await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout).toBe(statusBefore);
  }, 300_000);

  it("refused: same refused result as simplify directly, a failing check, and the branch is untouched", async () => {
    const intent = ["src/features/users.ts"];
    const dir = await materializePr("4", { baseRef: "base", intent });
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;

    const spark = [
      { category: "single-use-abstraction", file: "src/sharedApiClient.ts", citations: [cite("src/sharedApiClient.ts", 1, 13)], rationale: "looks like a wrapper" },
    ];
    const wonder = [
      { findingIndex: 0, action: "skip", rationale: "load-bearing: unwraps envelope, used by two features" },
    ];
    const client = scripted(spark, wonder);

    const viaPr = await runPrSimplifyCheck({ checkout: dir, sparkClient: client, wonderClient: client });
    const direct = await simplify({ checkout: dir, base: "base", intent, sparkClient: client, wonderClient: client });

    expect(viaPr.result).toEqual(direct);
    expect(viaPr.result.verdict).toBe("refused");
    expect(viaPr.result.patch).toBe("");

    // No edit reached the gate, so the gate is null and the check fails:
    // findings/plan text cannot satisfy branch protection.
    expect(viaPr.result.gate).toBeNull();
    expect(viaPr.check.body).toBe(JSON.stringify(direct.gate));
    expect(viaPr.check.body).toBe("null");
    expect(viaPr.check.conclusion).toBe("failure");

    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
  }, 300_000);
});
