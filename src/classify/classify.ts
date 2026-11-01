import { createGuestClient, type GuestClient, type ToolDefinition } from "./client.js";
import { CONVENTIONS, loadRepositoryConventions, unknownConventionNames } from "./conventions.js";
import { assertFitsWindow, readCheckoutSources, type CheckoutSource } from "./checkout.js";
import { citationExists, filterByEvidence, isSealedPath } from "./evidence.js";
import { decideConventionBreak, type ConventionDecision } from "./conventionBreak.js";
import {
  classifiedOutputSchema,
  MODEL_CATEGORIES,
  type ClassifiedOutput,
  type Finding,
} from "./schema.js";
import { decideScopeCreep, exemptScopeCreep, type ScopeCreepFinding } from "./scopeCreep.js";
import { verifyFindings, type VerificationDrop } from "./verify.js";
import { addUsage, emptyUsage, hashPrompt, type TokenUsage } from "../manifest.js";

export const REPORT_TOOL = "report_findings";

const REPORT_TOOL_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: REPORT_TOOL,
    description:
      "Report simplification findings. Every finding MUST cite exact lines that exist in the files shown; " +
      "findings without existing cited lines are dropped by the harness. " +
      "Use only the closed category set. Do NOT report scope-creep — that is decided by code, not by you.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["category", "file", "citations", "rationale"],
            properties: {
              category: { type: "string", enum: [...MODEL_CATEGORIES] },
              file: { type: "string", description: "Repo-relative path the finding is about." },
              citations: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["file", "startLine", "endLine"],
                  properties: {
                    file: { type: "string" },
                    startLine: { type: "integer", minimum: 1 },
                    endLine: { type: "integer", minimum: 1 },
                  },
                },
              },
              existingHelperFile: {
                type: "string",
                description: "duplicate-helper only: the pre-existing helper file to retarget callers to.",
              },
              convention: {
                type: "string",
                description: "convention-break only: the convention name, e.g. no-console-log.",
              },
              rationale: { type: "string" },
            },
          },
        },
      },
    },
  },
};

export interface ClassifyOptions {
  checkoutDir: string;
  /** Restrict classification to these repo-relative files (default: all non-sealed .ts). */
  files?: string[];
  /** Files changed vs base + PR intent, for the code-decided scope-creep pass. */
  scopeCreep?: { changedFiles: readonly string[]; intentFiles: readonly string[] };
  client?: GuestClient;
}

export interface ClassifyResult {
  /** Findings that survived zod, evidence, and (for conventions) fix-or-refuse. */
  findings: (Finding | ScopeCreepFinding)[];
  /** Model findings dropped because cited lines do not exist (or file is sealed/outside), or verification failed. */
  dropped: Finding[];
  /** Findings dropped by the code verification pass (LES-20), with reasons. */
  verificationDropped: VerificationDrop[];
  /** Convention names this repository wrote in lesscode-conventions.json. */
  registry: string[];
  /** Registry names code does not know, reported instead of silently ignored. */
  unknownConventions: string[];
  /** Changed non-behaviour paths kept instead of restored, with why. */
  scopeExemptions: { file: string; reason: string }[];
  refusedConventions: ConventionDecision[];
  /** Raw model output(s) as parsed JSON (pre-filter), for audit. */
  rawOutputs: unknown[];
  model: string;
  modelCalls: number;
  usage?: TokenUsage;
  /** SHA-256 of each prompt sent (hashes only, never prompt text). */
  promptHashes: string[];
}

function systemPrompt(): string {
  return [
    "You are the LessCode finding classifier (muse-spark-1.3). You inspect a TypeScript checkout and report surgical simplification findings.",
    "",
    "Closed finding set — report ONLY these categories:",
    "- single-use-abstraction: a class/function/wrapper used in exactly one place that forwards to another call; it should be inlined. Cite the wrapper definition and its single call site. Do NOT report a helper used by 2+ callers, or one that transforms data (unwrap, normalise, validate) — that is load-bearing, not single-use.",
    "- duplicate-helper: code added in this PR that reimplements a helper that already exists elsewhere in the checkout. Cite the duplicate and, in existingHelperFile, the existing helper's file; cite the existing helper's lines too.",
    `- convention-break: REPORT ONLY when (a) the repository documents that convention (in a README, AGENTS.md, lint config, or a comment at the site), or (b) the checkout is uniformly consistent except for the cited lines. Registered mechanical conventions you may name: ${CONVENTIONS.map((c) => c.name).join(", ")}. Name the convention in the "convention" field and cite the breaking lines. Do NOT invent conventions, and do NOT report style preferences (e.g. quote style or import-extension style) that the checkout itself does not uniformly follow — most checkouts here use double quotes and .js extensions, so those are the local convention, not breaks. When in doubt, report nothing in this category.`, 
    "",
    "Rules:",
    "- Use the report_findings tool. tool_choice is auto; call it when you have findings, or return an empty findings list if none.",
    "- EVERY finding must cite lines that exist in the files below, with exact 1-based line numbers from the numbered listing. Cite the definition and the relevant call sites.",
    "- Never invent files or line numbers. If you cannot cite it, do not report it.",
    "- Do not report scope-creep (decided by code). Do not propose edits, diffs, or line counts.",
  ].join("\n");
}

function numberedSource(s: CheckoutSource): string {
  const body = s.lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
  return `=== ${s.file} ===\n${body}`;
}

function extractFindingsJson(result: { toolCalls: { type: "function"; id: string; function: { name: string; arguments: string } }[]; content: string | null }): unknown {
  const call = result.toolCalls.find((t) => t.function.name === REPORT_TOOL);
  if (call) {
    try {
      return JSON.parse(call.function.arguments);
    } catch {
      // fall through to content parsing; zod will reject malformed shapes
      return { __unparseableToolArguments: call.function.arguments };
    }
  }
  if (result.content) {
    const start = result.content.indexOf("{");
    const end = result.content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(result.content.slice(start, end + 1));
      } catch {
        return { __unparseableContent: result.content };
      }
    }
  }
  return { findings: [] };
}

/**
 * Spark tool loop: one classification call, with exactly one retry when
 * the structured output fails zod validation. Findings are then kept
 * only when every citation points at lines that exist in the checkout,
 * and convention-break findings are kept only when a mechanical fix
 * applies (otherwise refused). Scope creep is appended by code.
 */
export async function classifyFindings(opts: ClassifyOptions): Promise<ClassifyResult> {
  if (isSealedPath(opts.checkoutDir)) throw new Error("refusing to classify a sealed directory");
  const files = opts.files?.filter((f) => !isSealedPath(f));
  const sources = readCheckoutSources(opts.checkoutDir, files);
  const client = opts.client ?? createGuestClient();

  const prompt = sources.map(numberedSource).join("\n\n");
  const baseMessages = [
    { role: "system" as const, content: systemPrompt() },
    { role: "user" as const, content: `Classify the findings in this checkout:\n\n${prompt}` },
  ];

  assertFitsWindow("classifier", client.config.model, prompt.length + systemPrompt().length);
  const rawOutputs: unknown[] = [];
  let validated: ClassifiedOutput | undefined;
  let lastIssues = "";
  const usage = emptyUsage();
  let sawUsage = false;
  const promptHashes: string[] = [];
  let modelCalls = 0;

  for (let attempt = 0; attempt < 2 && !validated; attempt++) {
    const messages =
      attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            {
              role: "user" as const,
              content:
                `Your previous structured output failed validation:\n${lastIssues}\n` +
                "Return a corrected report_findings call. Every finding needs category, file, a non-empty citations array " +
                "with existing 1-based lines, and rationale. Categories: " +
                MODEL_CATEGORIES.join(", ") +
                ".",
            },
          ];
    promptHashes.push(hashPrompt(messages));
    const result = await client.chat({ messages, tools: [REPORT_TOOL_DEF], toolChoice: "auto" });
    modelCalls++;
    if (result.usage) { sawUsage = true; addUsage(usage, result.usage); }
    const raw = extractFindingsJson(result);
    rawOutputs.push(raw);
    const parsed = classifiedOutputSchema.safeParse(raw);
    if (parsed.success) {
      validated = parsed.data;
    } else {
      lastIssues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      if (attempt === 1) {
        // One retry allowed; after that the run keeps nothing rather
        // than guessing from unvalidated model output.
        validated = { findings: [] };
      }
    }
  }

  const all = validated?.findings ?? [];
  const evidenceKept = filterByEvidence(opts.checkoutDir, all);
  const keptSet = new Set(evidenceKept);
  const evidenceDropped = all.filter((f) => !keptSet.has(f as Finding));

  // Verification (LES-20): code decides whether single-use and
  // duplicate findings are actually true; failures drop with a reason.
  const verification = verifyFindings(opts.checkoutDir, evidenceKept);
  const kept = verification.kept;
  const dropped = [...evidenceDropped, ...verification.dropped.map((d) => d.finding)];

  // Convention-break: mechanical fix or refuse. A fix is applied only
  // when the repository wrote the practice down in its registry;
  // otherwise the finding is refused (the review note may still carry it).
  const registry = loadRepositoryConventions(opts.checkoutDir);
  const unknownConventions = unknownConventionNames(registry);
  const conventionFindings = kept.filter((f) => f.category === "convention-break");
  const decisions = decideConventionBreak(opts.checkoutDir, conventionFindings, registry);
  const refusedConventions = decisions.filter((d) => d.status === "refused");
  const refusedSet = new Set(refusedConventions.map((d) => d.finding));
  const finalModel = kept.filter((f) => !refusedSet.has(f));

  // Scope creep: code-decided, appended after the model pass. Cited at
  // line 1 — kept by the evidence filter only when that line exists.
  // A creep file deleted from the checkout cannot cite line 1 of the
  // checkout; it is still a code-decided restore, so it is kept and the
  // caller's restore step resolves it against the base ref.
  let scopeFindings: ScopeCreepFinding[] = [];
  if (opts.scopeCreep) {
    scopeFindings = decideScopeCreep(opts.scopeCreep).filter(
      (f) =>
        f.citations.every((c) => citationExists(opts.checkoutDir, c)) ||
        !isSealedPath(f.file),
    );
  }

  return {
    findings: [...finalModel, ...scopeFindings],
    dropped,
    verificationDropped: verification.dropped,
    registry,
    unknownConventions,
    scopeExemptions: opts.scopeCreep ? exemptScopeCreep(opts.scopeCreep) : [],
    refusedConventions,
    rawOutputs,
    model: client.config.model,
    modelCalls,
    usage: sawUsage ? usage : undefined,
    promptHashes,
  };
}
