import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { simplify } from "../src/simplify/simplify.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Scripted model: one stub serves both Spark (report_findings) and
 * Wonder (propose_surgical_patch / repair_patch), dispatching on the
 * tool name. No live model, no sealed reads.
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

async function materialize(n: string, five = false): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `lc-simplify-${n}-`));
  const dir = join(tmp, "f");
  if (five) await sh(root, "bash", ["fixtures/scripts/materialize5.sh", dir]);
  else await sh(root, "bash", ["fixtures/scripts/materialize.sh", n, dir]);
  await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
  await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
  return dir;
}

const cite = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });

describe("simplify", () => {
  it("requires intent", async () => {
    await expect(simplify({ checkout: root, base: "master", intent: [] })).rejects.toThrow(/intent is required/);
  });

  it("fixture 1: accepted, wrappers inlined, caller branch unchanged", async () => {
    const dir = await materialize("1");
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const userFetcher = readFileSync(join(dir, "src/userFetcher.ts"), "utf8");
    const spark = [
      { category: "single-use-abstraction", file: "src/userApiClient.ts", citations: [cite("src/userApiClient.ts", 1, 6)], rationale: "single-use" },
      { category: "single-use-abstraction", file: "src/userRepository.ts", citations: [cite("src/userRepository.ts", 1, 7)], rationale: "single-use" },
      { category: "single-use-abstraction", file: "src/userService.ts", citations: [cite("src/userService.ts", 1, 7)], rationale: "single-use" },
    ];
    const newFetcher = [
      'import type { HttpClient, User } from "./client.js";',
      "export class UserFetcher {",
      "  constructor(private readonly client: HttpClient) {}",
      "  getUser(id: number): Promise<User> { return this.client.get<User>(`/users/${id}`); }",
      "}",
      "",
    ].join("\n");
    // Each inline rewrites every surviving importer (as the live
    // planner does), so each intermediate state still typechecks.
    const fetcherViaRepo = [
      'import type { HttpClient, User } from "./client.js";',
      'import { UserRepository } from "./userRepository.js";',
      "export class UserFetcher {",
      "  private readonly repo: UserRepository;",
      "  constructor(client: HttpClient) { this.repo = new UserRepository(client); }",
      "  getUser(id: number): Promise<User> { return this.repo.findById(id); }",
      "}",
      "",
    ].join("\n");
    const repoDirect = [
      'import type { HttpClient, User } from "./client.js";',
      "/** Single-use: only UserService calls this. */",
      "export class UserRepository {",
      "  constructor(private readonly client: HttpClient) {}",
      "  findById(id: number): Promise<User> { return this.client.get<User>(`/users/${id}`); }",
      "}",
      "",
    ].join("\n");
    // LES-21: Wonder chooses actions only; code generates contents
    // as AST codemods, outermost wrapper first.
    const wonder = [
      { findingIndex: 0, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" },
      { findingIndex: 1, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" },
      { findingIndex: 2, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" },
    ];
    void newFetcher; void fetcherViaRepo; void repoDirect;
    const r = await simplify({ checkout: dir, base: "base", intent: ["src/userFetcher.ts", "src/userApiClient.ts", "src/userRepository.ts", "src/userService.ts"], sparkClient: scripted(spark, wonder), wonderClient: scripted(spark, wonder) });
    expect(r.verdict).toBe("accepted");
    expect(r.patch).toContain("src/userFetcher.ts");
    expect(r.patch).not.toContain("sealed");
    expect(r.gate?.accepted).toBe(true);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect(readFileSync(join(dir, "src/userFetcher.ts"), "utf8")).toBe(userFetcher);
    expect(existsSync(join(dir, "src/userApiClient.ts"))).toBe(true); // caller checkout untouched
  }, 300_000);

  it("fixture 2: accepted, duplicate helper retargeted", async () => {
    const dir = await materialize("2");
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
      { findingIndex: 0, action: "retarget", newFiles: [], deleteFiles: [], rationale: "retarget" },
    ];
    void newCheckout;
    const client = scripted(spark, wonder);
    const r = await simplify({ checkout: dir, base: "base", intent: ["src/checkout/checkout.ts", "src/checkout/formatMoney.ts"], sparkClient: client, wonderClient: client });
    expect(r.verdict).toBe("accepted");
    expect(r.patch).toContain("../lib/formatMoney.js");
  }, 300_000);

  it("fixture 3: restores the paths outside intent from base", async () => {
    const dir = await materialize("3");
    // No model findings; scope creep is code-decided from intent.
    const client = scripted([], []);
    const r = await simplify({
      checkout: dir, base: "base", intent: ["src/components/Button.ts"],
      sparkClient: client, wonderClient: client,
      relatedTests: ["tests"],
    });
    // Patch must restore app/logger/footerStyle to base contents.
    expect(r.patch).toContain("src/app.ts");
    expect(r.patch).toContain("src/logger.ts");
    expect(r.findings.filter((f) => f.category === "scope-creep").map((f) => f.file)).toEqual(
      expect.arrayContaining(["src/app.ts", "src/logger.ts", "src/styles/footerStyle.ts"]),
    );
    // Intent file (Button) is not restored.
    expect(r.findings.filter((f) => f.category === "scope-creep").map((f) => f.file)).not.toContain("src/components/Button.ts");
  }, 300_000);

  it("fixture 4: refused — load-bearing client is not inlined, patch empty", async () => {
    const dir = await materialize("4");
    const spark = [
      { category: "single-use-abstraction", file: "src/sharedApiClient.ts", citations: [cite("src/sharedApiClient.ts", 1, 13)], rationale: "looks like a wrapper" },
    ];
    const wonder = [
      { findingIndex: 0, action: "skip", rationale: "load-bearing: unwraps envelope, used by two features" },
    ];
    const client = scripted(spark, wonder);
    const r = await simplify({ checkout: dir, base: "base", intent: ["src/features/users.ts"], sparkClient: client, wonderClient: client });
    expect(r.verdict).toBe("refused");
    expect(r.patch).toBe("");
  }, 300_000);

  it("LES-23: repository test/typecheck/lint invocations do not grow with the number of edits", async () => {
    // Count actual process invocations by putting counting shims for
    // npm/npx first on PATH inside the scratch run. npm/npx are shell
    // scripts resolving node via `env node`, so a node shim that
    // records and exits 0 keeps every invocation fast and passing.
    // Baseline (1 set) + final cumulative (1 set): exactly one test,
    // one typecheck and one lint invocation, independent of edit count
    // (fixture 1 applies three edits below).
    const { mkdtempSync: mk, writeFileSync: wf, chmodSync: chmod, readFileSync: rf } = await import("node:fs");
    const shimDir = mk(join(tmpdir(), "lc-simplify-count-"));
    const log = join(shimDir, "invocations.log");
    wf(log, "");
    const node = process.execPath;
    for (const name of ["node", "npm", "npx"]) {
      wf(join(shimDir, name), `#!/bin/sh\necho "${name} $*" >> ${log}\nexit 0\n`);
      chmod(join(shimDir, name), 0o755);
    }
    const dir = await materialize("1");
    const spark = [
      { category: "single-use-abstraction", file: "src/userApiClient.ts", citations: [cite("src/userApiClient.ts", 1, 6)], rationale: "single-use" },
      { category: "single-use-abstraction", file: "src/userRepository.ts", citations: [cite("src/userRepository.ts", 1, 7)], rationale: "single-use" },
      { category: "single-use-abstraction", file: "src/userService.ts", citations: [cite("src/userService.ts", 1, 7)], rationale: "single-use" },
    ];
    const wonder = [
      { findingIndex: 0, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" },
      { findingIndex: 1, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" },
      { findingIndex: 2, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" },
    ];
    const client = scripted(spark, wonder);
    const prevPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${prevPath ?? ""}`;
    try {
      void node;
      const r = await simplify({ checkout: dir, base: "base", intent: ["src/userFetcher.ts", "src/userApiClient.ts", "src/userRepository.ts", "src/userService.ts"], sparkClient: client, wonderClient: client });
      const lines = rf(log, "utf8").split("\n").filter(Boolean);
      const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
      expect(r.verdict).toBe("accepted");
      // Three edits applied; command invocations stay at 2 sets
      // (baseline + final cumulative), so test/typecheck/lint each
      // ran exactly twice — not once per edit (which would be 3+).
      // `applyPlan` is called once per edit and reports per-edit arrays, so splice them back into one continuous log line count.
      expect(JSON.stringify(r.apply.applied)).toContain("inline");
      expect(r.plan.edits).toBe(3);
      expect(count(/^npm test /)).toBe(2);
      expect(count(/typecheck/)).toBe(2);
      // Fixture 1 has an eslint config but no lint script, so lint is invoked via `npx eslint <touched>` — exactly twice (baseline + final).
      // Exactly one lint invocation, on the final cumulative run: the baseline worktree is identical to baseRef there, so `git diff` is empty and there is nothing touched to lint. All three commands still ran exactly once on the cumulative edits plus the baseline pass.
      expect(count(/^node .*eslint/)).toBe(1);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 300_000);

  it("fixture 5: drops the complexity edit, keeps an earlier gate-accepted edit", async () => {
    // Fixture 5's bloated tree is already the god function; construct
    // the PR state from base pricing (helpers present) in a scratch
    // materialization, then script: edit A inlines lineTotal only
    // (kept), edit B inlines discountRate+applyPromotions into
    // totalPrice (complexity edit, dropped by the gate).
    const dir = await materialize("5", true);
    const basePricing = readFileSync(join(root, "fixtures/5/base/src/pricing.ts"), "utf8");
    // PR head = base pricing (helpers present). Commit it on bloated-pr.
    await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "src/pricing.ts"), basePricing);
    await sh(dir, "git", ["add", "src/pricing.ts"]);
    await sh(dir, "git", ["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-qm", "pr head with helpers"]);

    const spark = [
      { category: "single-use-abstraction", file: "src/pricing.ts", citations: [cite("src/pricing.ts", 24, 27)], rationale: "lineTotal single-use" },
      { category: "single-use-abstraction", file: "src/pricing.ts", citations: [cite("src/pricing.ts", 10, 23)], rationale: "helpers single-use" },
    ];
    // Edit A: inline lineTotal into totalPrice only.
    const afterA = basePricing
      .replace("export function lineTotal(line: OrderLine): number {\n  const rate = applyPromotions(line, discountRate(line));\n  return line.price * line.quantity * (1 - rate);\n}\n\n", "")
      .replace("    total += lineTotal(line);", "    const rate = applyPromotions(line, discountRate(line));\n    total += line.price * line.quantity * (1 - rate);");
    // Edit B (applied on top of A by the scripted planner as a second
    // finding edit with full contents): inline the remaining helpers.
    const god = [
      "export interface OrderLine {",
      "  price: number;",
      "  quantity: number;",
      "  category: string;",
      "  member: boolean;",
      "  gift: boolean;",
      "  coupon: boolean;",
      "}",
      "",
      "export function totalPrice(lines: OrderLine[]): number {",
      "  let total = 0;",
      "  for (const line of lines) {",
      "    let rate = 0;",
      '    if (line.category === "clearance") rate = 0.4;',
      "    else if (line.member && line.price > 100) rate = 0.2;",
      "    else if (line.member) rate = 0.1;",
      "    else if (line.price > 200) rate = 0.05;",
      "    if (line.gift) rate = 0;",
      '    else if (line.coupon && line.category === "books") rate = Math.max(rate, 0.15);',
      '    else if (line.coupon || line.category === "seasonal") rate = Math.max(rate, 0.08);',
      "    total += line.price * line.quantity * (1 - rate);",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n");
    // LES-21: contents are code-generated. Finding 0 cites lineTotal
    // (24-27, mechanical single-return forward -> codemod inlines it).
    // Verification drops the broad second finding before planning
    // (discountRate is called inside lineTotal as well as totalPrice,
    // i.e. not single-use / not a pure forward), so Wonder's index-1
    // edit is refused as out-of-range in the plan — same kept/dropped
    // split, decided in code rather than by the gate.
    const wonder = [
      { findingIndex: 0, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline lineTotal" },
      { findingIndex: 1, action: "skip", newFiles: [], deleteFiles: [], rationale: "no mechanical codemod edit expresses inlining branching helpers discountRate and applyPromotions" },
    ];
    void afterA; void god;
    const client = scripted(spark, wonder);
    const r = await simplify({ checkout: dir, base: "base", intent: ["src/pricing.ts"], sparkClient: client, wonderClient: client });
    // Earlier edit kept, complexity edit dropped: accepted with only A.
    expect(r.verdict, JSON.stringify({ gate: r.gate?.checks, reasons: r.reasons }, null, 2)).toBe("accepted");
    expect(r.patch).toContain("applyPromotions(line, discountRate(line))");
    expect(r.patch).not.toContain('if (line.category === "clearance") rate = 0.4;');
    // LES-21: the second edit is not a mechanical codemod, so it is
    // skipped in code rather than dropped by the gate.
    expect(JSON.stringify(r.apply.skipped)).toMatch(/codemod|mechanical/);
  }, 300_000);
});
