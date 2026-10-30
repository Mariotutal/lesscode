import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GuestClient } from "../classify/client.js";
import { applyConventionFix } from "../classify/conventionBreak.js";
import { loadRepositoryConventions } from "../classify/conventions.js";
import { repairOutputSchema, type PlannedEdit } from "./schema.js";
import { WONDER_MODEL } from "./plan.js";
import type { AnyFinding } from "./plan.js";

const exec = promisify(execFile);

export interface AppliedEdit { findingIndex: number; action: PlannedEdit["action"]; files: string[]; repaired: boolean }
export interface SkippedEdit { findingIndex: number; reason: string }
export interface ApplyResult {
  applied: AppliedEdit[];
  skipped: SkippedEdit[];
  /** Files the gate should treat as the edit set (applied edits only). */
  editSet: string[];
  repairCalls: number;
  repairUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function tscErrors(repo: string): Promise<string | null> {
  try {
    await exec("npx", ["tsc", "--noEmit"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(0, 4000) || "tsc failed";
  }
}

async function gitShow(repo: string, ref: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["show", `${ref}:${file}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch { return null; }
}

interface Snapshot { file: string; content: string | null }
const snap = (repo: string, files: string[]): Snapshot[] =>
  files.map((file) => ({ file, content: existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8") : null }));
function restore(repo: string, snaps: Snapshot[]): void {
  for (const s of snaps) {
    if (s.content === null) rmSync(join(repo, s.file), { force: true });
    else writeFileSync(join(repo, s.file), s.content);
  }
}
function writeEdit(repo: string, edit: PlannedEdit): void {
  for (const f of edit.newFiles) writeFileSync(join(repo, f.file), f.content);
  for (const f of edit.deleteFiles) rmSync(join(repo, f), { force: true });
}

/**
 * Apply planned edits one at a time. After each edit, run tsc; on
 * failure take ONE Wonder repair turn carrying the compiler error,
 * then skip that finding (revert its files) and continue with what
 * remains. restore-from-base and convention-fix contents come from
 * code, never from the model. The gate runs afterwards, on the result.
 */
export async function applyPlan(opts: {
  checkoutDir: string;
  baseRef: string;
  findings: readonly AnyFinding[];
  edits: readonly PlannedEdit[];
  client?: GuestClient;
  runTsc?: (repo: string) => Promise<string | null>;
}): Promise<ApplyResult> {
  const checkTsc = opts.runTsc ?? tscErrors;
  const applied: AppliedEdit[] = [];
  const skipped: SkippedEdit[] = [];
  let repairCalls = 0;
  let repairUsage: ApplyResult["repairUsage"];

  for (const edit of opts.edits) {
    const finding = opts.findings[edit.findingIndex]!;
    let effective: PlannedEdit = edit;

    if (edit.action === "restore-from-base") {
      const before = snap(opts.checkoutDir, [finding.file]);
      const base = await gitShow(opts.checkoutDir, opts.baseRef, finding.file);
      if (base === null) rmSync(join(opts.checkoutDir, finding.file), { force: true });
      else writeFileSync(join(opts.checkoutDir, finding.file), base);
      const err = await checkTsc(opts.checkoutDir);
      if (err) { restore(opts.checkoutDir, before); skipped.push({ findingIndex: edit.findingIndex, reason: `restore broke tsc, reverted: ${err.split("\n")[0]}` }); continue; }
      applied.push({ findingIndex: edit.findingIndex, action: edit.action, files: [finding.file], repaired: false });
      continue;
    }

    if (edit.action === "convention-fix") {
      if (finding.category !== "convention-break") { skipped.push({ findingIndex: edit.findingIndex, reason: "convention-fix on non-convention finding" }); continue; }
      // Applied only from the repository convention registry.
      if (!finding.convention || !loadRepositoryConventions(opts.checkoutDir).includes(finding.convention)) {
        skipped.push({ findingIndex: edit.findingIndex, reason: `convention "${finding.convention ?? "(none)"}" is not in the repository convention registry; note only, not applied` });
        continue;
      }
      const fixed = applyConventionFix(opts.checkoutDir, finding);
      if (fixed === undefined) { skipped.push({ findingIndex: edit.findingIndex, reason: "mechanical fix changed nothing; refused" }); continue; }
      const before = snap(opts.checkoutDir, [finding.file]);
      writeFileSync(join(opts.checkoutDir, finding.file), fixed);
      const err = await checkTsc(opts.checkoutDir);
      if (err) { restore(opts.checkoutDir, before); skipped.push({ findingIndex: edit.findingIndex, reason: `convention fix broke tsc, reverted: ${err.split("\n")[0]}` }); continue; }
      applied.push({ findingIndex: edit.findingIndex, action: edit.action, files: [finding.file], repaired: false });
      continue;
    }

    // inline / retarget: model-supplied full file contents.
    const touched = [...new Set([...effective.newFiles.map((f) => f.file), ...effective.deleteFiles])];
    const before = snap(opts.checkoutDir, touched);
    writeEdit(opts.checkoutDir, effective);
    let err = await checkTsc(opts.checkoutDir);
    let repaired = false;
    if (err && opts.client) {
      // One repair turn with the compiler error, then skip the finding.
      repairCalls++;
      try {
        const res = await opts.client.chat({
          messages: [
            { role: "system", content: "You repair one LessCode surgical edit. Return corrected FULL contents for the same files only, via repair_patch. Do not reimplement the feature; fix only what the compiler error names." },
            { role: "user", content: `Edit action=${edit.action} for finding ${finding.category} on ${finding.file}.\nFiles you may rewrite: ${effective.newFiles.map((f) => f.file).join(", ") || "(none)"}\nCurrent attempted contents:\n${effective.newFiles.map((f) => `=== ${f.file} ===\n${f.content}`).join("\n")}\ntsc error:\n${err}` },
          ],
          tools: [{
            type: "function",
            function: {
              name: "repair_patch",
              description: "Corrected full file contents for the failing edit.",
              parameters: {
                type: "object", additionalProperties: false, required: ["newFiles"],
                properties: { newFiles: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "content"], properties: { file: { type: "string" }, content: { type: "string" } } } } },
              },
            },
          }],
          toolChoice: "auto",
        });
        repairUsage = res.usage ?? repairUsage;
        const call = res.toolCalls.find((t) => t.function.name === "repair_patch");
        const raw: unknown = call ? JSON.parse(call.function.arguments) : null;
        const parsed = repairOutputSchema.safeParse(raw);
        const allowedFiles = new Set(effective.newFiles.map((f) => f.file));
        if (parsed.success && parsed.data.newFiles.every((f) => allowedFiles.has(f.file))) {
          effective = { ...effective, newFiles: parsed.data.newFiles };
          restore(opts.checkoutDir, before);
          writeEdit(opts.checkoutDir, effective);
          err = await checkTsc(opts.checkoutDir);
          repaired = !err;
        }
      } catch { /* repair failed: fall through to skip */ }
    }
    if (err) {
      restore(opts.checkoutDir, before);
      skipped.push({ findingIndex: edit.findingIndex, reason: `tsc failed after one repair turn, finding skipped: ${err.split("\n")[0]}` });
      continue;
    }
    applied.push({ findingIndex: edit.findingIndex, action: edit.action, files: touched, repaired });
  }

  const editSet = [...new Set(applied.flatMap((a) => a.files))];
  return { applied, skipped, editSet, repairCalls, repairUsage };
}

export { WONDER_MODEL };
