import { createGuestClient, type GuestClient, type ToolDefinition } from "../classify/client.js";
import type { Finding } from "../classify/schema.js";
import type { ScopeCreepFinding } from "../classify/scopeCreep.js";
import { readCheckoutSources } from "../classify/checkout.js";
import { isSealedPath } from "../classify/evidence.js";
import { planOutputSchema, wonderOutputSchema, type PlannedEdit, type ReviewNoteItem } from "./schema.js";

export const WONDER_MODEL = "muse-wonder-1.0";
export const PLAN_TOOL = "propose_surgical_patch";

const PLAN_TOOL_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: PLAN_TOOL,
    description:
      "Choose which findings become surgical edits. inline = inline a single-use wrapper at its one call site and delete its file; " +
      "retarget = delete a duplicate helper and point its callers at the existing helper; " +
      "restore-from-base and convention-fix are executed by code (return them with empty newFiles); skip = refuse the finding. " +
      "For inline/retarget give FULL new contents of every file you rewrite. Do not reimplement any feature.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["edits"],
      properties: {
        review: {
          type: "array",
          description: "Senior note items (never applied). Each cites existing lines.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text", "citations"],
            properties: {
              kind: { type: "string", enum: ["boundary", "name-mismatch", "test-gap", "load-bearing", "question", "practice"] },
              text: { type: "string" },
              citations: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["file", "startLine", "endLine"], properties: { file: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } } } },
              ordersEditForFinding: { type: "integer", minimum: 0 },
            },
          },
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["findingIndex", "action", "rationale"],
            properties: {
              findingIndex: { type: "integer", minimum: 0 },
              action: { type: "string", enum: ["inline", "retarget", "restore-from-base", "convention-fix", "skip"] },
              newFiles: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["file", "content"],
                  properties: { file: { type: "string" }, content: { type: "string" } },
                },
              },
              deleteFiles: { type: "array", items: { type: "string" } },
              rationale: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export type AnyFinding = Finding | ScopeCreepFinding;

export interface PlanResult {
  edits: PlannedEdit[];
  /** Senior note items returned in the SAME single Wonder call (unfiltered; code filters). */
  review: ReviewNoteItem[];
  skipped: { findingIndex: number; reason: string }[];
  model: string;
  modelCalls: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  rawOutput: unknown;
}

function extractJson(result: { toolCalls: { function: { name: string; arguments: string } }[]; content: string | null }): unknown {
  const call = result.toolCalls.find((t) => t.function.name === PLAN_TOOL);
  if (call) {
    try { return JSON.parse(call.function.arguments); } catch { return { __unparseable: call.function.arguments }; }
  }
  if (result.content) {
    const s = result.content.indexOf("{"), e = result.content.lastIndexOf("}");
    if (s >= 0 && e > s) { try { return JSON.parse(result.content.slice(s, e + 1)); } catch { return { __unparseable: result.content }; } }
  }
  return { edits: [] };
}

const ACTION_FOR: Record<string, PlannedEdit["action"]> = {
  "single-use-abstraction": "inline",
  "duplicate-helper": "retarget",
  "scope-creep": "restore-from-base",
  "convention-break": "convention-fix",
};

/**
 * Exactly ONE Wonder plan call per run. No retry: if the plan fails
 * zod, the run plans nothing (the gate then judges an empty patch and
 * rejects on size). Validation is code-side: edit paths must belong
 * to the finding they claim, actions must match the finding category,
 * and sealed/out-of-checkout paths void that edit.
 */
export async function planOnce(opts: {
  checkoutDir: string;
  findings: readonly AnyFinding[];
  client?: GuestClient;
}): Promise<PlanResult> {
  const client = opts.client ?? createGuestClient({ env: { ...process.env, META_MODEL: WONDER_MODEL } });
  const sources = readCheckoutSources(opts.checkoutDir);
  const numbered = sources.map((s) => `=== ${s.file} ===\n${s.lines.map((l, i) => `${i + 1}\t${l}`).join("\n")}`).join("\n\n");
  const findingsText = opts.findings.map((f, i) =>
    `[${i}] ${f.category} file=${f.file}` +
    (f.category === "duplicate-helper" && f.existingHelperFile ? ` existingHelperFile=${f.existingHelperFile}` : "") +
    (f.category === "convention-break" && f.convention ? ` convention=${f.convention}` : "") +
    ` citations=${f.citations.map((c) => `${c.file}:${c.startLine}-${c.endLine}`).join(",")} rationale=${f.rationale}`,
  ).join("\n");

  const result = await client.chat({
    messages: [
      {
        role: "system",
        content: [
          "You are the LessCode planner (muse-wonder-1.0). You plan ONCE. Choose which findings become surgical edits; do not reimplement the feature.",
          "A single-use forward is an inline, not an essay: the surviving caller calls the underlying operation directly and the wrapper file is deleted.",
          "duplicate-helper: delete the duplicate file, rewrite each caller to import the existing helper, leave the existing helper untouched.",
          "scope-creep: action restore-from-base with empty newFiles/deleteFiles — code restores it.",
          "convention-break: action convention-fix with empty newFiles — code applies the mechanical fix.",
          "Refuse (skip) any finding whose code is load-bearing (transforms/unwraps/normalises) or not truly single-use/duplicate. When in doubt, skip.",
          "ALSO return `review`: the senior note, in the SAME response. The note covers only what a lead would say and a checker cannot prove: a boundary that hides the wrong concept (kind boundary), a name that disagrees with the concept already in the repository (name-mismatch), a test that does not lock the behaviour the change claims (test-gap), a load-bearing symbol that must stay (load-bearing), a practice this repository has not written in its convention registry (practice), or a question for the author (question). Each item cites a line that exists. Set ordersEditForFinding only when the item orders an edit for a finding index. The note is never applied.",
          "For inline/retarget, newFiles must contain the FULL new content of every rewritten file, preserving all other behaviour byte-for-byte in spirit. Never edit tests. Never touch sealed paths (none are shown).",
        ].join("\n"),
      },
      { role: "user", content: `Findings:\n${findingsText}\n\nCheckout (numbered lines):\n\n${numbered}` },
    ],
    tools: [PLAN_TOOL_DEF],
    toolChoice: "auto",
  });

  const raw = extractJson(result);
  // Accept the combined Wonder output; fall back to an edits-only plan
  // (note then empty) so older scripted/live responses still validate.
  const wonderParsed = wonderOutputSchema.safeParse(raw);
  const parsedData = wonderParsed.success
    ? wonderParsed.data
    : (() => { const p = planOutputSchema.safeParse(raw); return p.success ? { edits: p.data.edits, review: [] as ReviewNoteItem[] } : null; })();
  const skipped: PlanResult["skipped"] = [];
  if (!parsedData) {
    // One plan only. An invalid plan becomes no edits, never a second call.
    return { edits: [], review: [], skipped: opts.findings.map((_, i) => ({ findingIndex: i, reason: "plan failed schema validation" })), model: client.config.model, modelCalls: 1, usage: result.usage, rawOutput: raw };
  }
  const parsed = { data: parsedData };

  // Surgical scope for inline/retarget: the finding's file, its cited
  // files, the existing helper (retarget), and every file that imports
  // the finding's file — those importers are its call sites, which the
  // classifier may not cite even though the edit must rewrite them.
  const importersOf = (target: string): string[] => {
    const stem = target.replace(/\.[cm]?[jt]sx?$/, "");
    return sources.filter((s) => {
      if (s.file === target) return false;
      return [...s.text.matchAll(/from\s+["']([^"']+)["']/g)].some((m) => {
        const spec = m[1]!;
        if (!spec.startsWith(".")) return false;
        const parts: string[] = [];
        for (const seg of `${s.file.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
          if (seg === "..") parts.pop(); else if (seg !== "." && seg !== "") parts.push(seg);
        }
        return parts.join("/").replace(/\.[cm]?[jt]sx?$/, "") === stem;
      });
    }).map((s) => s.file);
  };

  const edits: PlannedEdit[] = [];
  const seen = new Set<number>();
  for (const edit of parsed.data.edits) {
    const finding = opts.findings[edit.findingIndex];
    if (!finding || seen.has(edit.findingIndex)) { skipped.push({ findingIndex: edit.findingIndex, reason: "unknown or duplicate finding index" }); continue; }
    seen.add(edit.findingIndex);
    if (edit.action === "skip") { skipped.push({ findingIndex: edit.findingIndex, reason: `planner skipped: ${edit.rationale}` }); continue; }
    if (edit.action !== ACTION_FOR[finding.category]) {
      skipped.push({ findingIndex: edit.findingIndex, reason: `action ${edit.action} does not match category ${finding.category}` });
      continue;
    }
    const allowed = new Set([finding.file, ...finding.citations.map((c) => c.file), ...importersOf(finding.file),
      ...(finding.category === "duplicate-helper" && finding.existingHelperFile ? [finding.existingHelperFile] : [])]);
    const paths = [...edit.newFiles.map((f) => f.file), ...edit.deleteFiles];
    if (paths.some((p) => isSealedPath(p) || /(^|\/)tests?\//.test(p) || /\.test\.ts$/.test(p))) {
      skipped.push({ findingIndex: edit.findingIndex, reason: "edit touches tests or sealed paths" });
      continue;
    }
    if ((edit.action === "inline" || edit.action === "retarget") && paths.some((p) => !allowed.has(p))) {
      skipped.push({ findingIndex: edit.findingIndex, reason: `edit touches files outside the finding's cited set: ${paths.filter((p) => !allowed.has(p)).join(", ")}` });
      continue;
    }
    if (edit.action === "retarget" && !(edit.deleteFiles.includes(finding.file))) {
      skipped.push({ findingIndex: edit.findingIndex, reason: "retarget must delete the duplicate file" });
      continue;
    }
    edits.push(edit);
  }
  opts.findings.forEach((_, i) => { if (!seen.has(i)) skipped.push({ findingIndex: i, reason: "planner made no decision for this finding" }); });
  return { edits, review: parsed.data.review, skipped, model: client.config.model, modelCalls: 1, usage: result.usage, rawOutput: raw };
}
