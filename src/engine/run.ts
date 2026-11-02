import { randomUUID } from "node:crypto";
import { classifyFindings } from "../classify/classify.js";
import { createModelClient } from "../provider/factory.js";
import type { GuestClient } from "../provider/types.js";
import { changedFilesFromGit, changedLinesFromGit, contextWindow, estimateTokens, expandIntentFiles, isTestFile, listClassifiableFiles, matchesIntent, readCheckoutSources, readTsConfig, scopedReviewFiles } from "../classify/checkout.js";
import { citationExistsInText, isSealedPath } from "../classify/evidence.js";
import { findTarget, parse } from "../classify/target.js";
import type { Finding } from "../classify/schema.js";
import { createTrustedLocalExecutor, type RepositoryExecutor } from "../execution/index.js";
import { evaluateCheapGate, evaluateCommandGate, type GateResult } from "../gate/gate.js";
import { addUsage, hashPrompt, ManifestBuilder, renderRunSummary } from "../manifest.js";
import { prepareEdit } from "../plan/apply.js";
import { planOnce, type AnyFinding } from "../plan/plan.js";
import type { PlannedEdit, ReviewNoteItem } from "../plan/schema.js";
import { hashText, transactEdit } from "./transaction.js";
import { changedPaths, fileText, git, openWorkspace, readGitFile } from "./workspace.js";
import type { DecisionReason, EditOutcome, ReviewRequest, RunAudit, RunRecord } from "./types.js";

const emptyAudit = (): RunAudit => ({ droppedFindings: 0, recoveredFindings: [], registry: [], unknownConventions: [], refusedConventions: [], plan: { edits: 0, skipped: [], model: "", modelCalls: 0, review: [] }, reasons: [], tsConfig: { allowJs: false, checkJs: false } });
const reason = (code: DecisionReason["code"], stage: DecisionReason["stage"], detail: string): DecisionReason => ({ code, stage, detail });

function instrument(client: GuestClient, role: "spark" | "wonder", manifest: ManifestBuilder, signal?: AbortSignal): GuestClient {
  if (role === "spark") manifest.sparkModel = client.config.model; else manifest.wonderModel = client.config.model;
  return { config: client.config, async chat(request) {
    signal?.throwIfAborted();
    if (role === "spark") manifest.sparkCalls++; else manifest.wonderCalls++;
    manifest.promptHashes.push(hashPrompt(request.messages));
    const response = await client.chat({ ...request, signal });
    addUsage(manifest.usage, response.usage);
    signal?.throwIfAborted();
    return response;
  } };
}

function findingIds(findings: readonly AnyFinding[]): string[] {
  return findings.map((finding, index) => `finding-${hashText(JSON.stringify(finding)).slice(0, 16)}-${index}`);
}

async function targetedSymbols(repo: string, head: string, edits: readonly EditOutcome[], findings: readonly AnyFinding[]) {
  const targets: { file: string; name: string }[] = [];
  for (const edit of edits.filter((e) => e.status === "kept")) {
    const f = findings[edit.findingIndex];
    if (!f || f.category === "scope-creep" || f.category === "convention-break") continue;
    const source = await readGitFile(repo, head, f.file);
    const target = source === null ? undefined : findTarget(parse(f.file, source), f.file, f as Finding);
    if (target) targets.push({ file: f.file, name: target.name });
  }
  return targets;
}

function finalizeNote(record: RunRecord, texts: Map<string, string>, changedLines: Map<string, Set<number>>, intentChanged: boolean): void {
  const items: ReviewNoteItem[] = [];
  const cited = (item: ReviewNoteItem) => item.citations.every((c) => texts.has(c.file) && citationExistsInText(c, texts.get(c.file)!));
  for (const item of record.audit.plan.review) {
    if (!cited(item)) continue;
    const onChanged = !intentChanged || item.citations.some((c) => [...(changedLines.get(c.file) ?? [])].some((n) => n >= c.startLine && n <= c.endLine));
    if (!onChanged && !/change itself is sound|change is sound|^sound\b/i.test(item.text.trim())) {
      record.audit.reasons.push(`note item dropped: it does not cite a line the pull request changed: ${item.text}`);
      continue;
    }
    if (item.ordersEditForFinding !== undefined) {
      const outcome = record.edits.find((e) => e.findingIndex === item.ordersEditForFinding && e.status === "kept");
      if (!outcome) {
        const rejected = record.edits.find((e) => e.findingIndex === item.ordersEditForFinding);
        const detail = rejected?.reason?.detail ?? "no gate-accepted edit was applied for this finding";
        items.push({ ...item, text: `Not applied: ${detail}`, ordersEditForFinding: undefined });
        record.audit.reasons.push(`finding ${item.ordersEditForFinding} kept and produces no patch: ${detail}`);
        continue;
      }
    }
    items.push(item);
  }
  for (const refused of record.audit.refusedConventions) {
    if (items.some((i) => i.kind === "practice" && i.citations[0]?.file === refused.file)) continue;
    const item: ReviewNoteItem = { kind: "practice", text: `Practice "${refused.convention}" is not applied: ${refused.rationale}`, citations: refused.citations };
    if (cited(item)) items.push(item);
  }
  record.review = { items, markdown: items.length ? ["## Lead review", "", ...items.map((item) => `- (${item.kind}) ${item.text} [${item.citations.map((c) => `${c.file}:${c.startLine}-${c.endLine}`).join(", ")}]`), ""].join("\n") : "" };
}

/** One owner of source identity, edit transactions, verification, and final evidence. */
export async function runReview(opts: ReviewRequest): Promise<RunRecord> {
  const manifest = new ManifestBuilder();
  const execution = opts.executor ?? createTrustedLocalExecutor();
  const executor: RepositoryExecutor = {
    kind: execution.kind,
    get environmentId() { return execution.environmentId; },
    async prepare(repoDir) { opts.signal?.throwIfAborted(); await execution.prepare(repoDir); opts.signal?.throwIfAborted(); },
    run: (command) => execution.run({ ...command, signal: opts.signal ?? command.signal }),
    runSync: (command) => { opts.signal?.throwIfAborted(); return execution.runSync(command); },
    dispose: () => execution.dispose(),
  };
  const record: RunRecord = { schemaVersion: 1, runId: randomUUID(), state: "completed", verdict: "reviewed", outcome: "no-change", revision: null,
    execution: { kind: executor.kind, policyVersion: 1 }, findings: [], findingIds: [], edits: [], gate: null,
    verification: { status: "not-run", treeHash: null }, artifact: null, review: { items: [], markdown: "" }, manifest: manifest.build(), audit: emptyAudit(), failure: null };
  let stage = "resolve";
  let workspace: Awaited<ReturnType<typeof openWorkspace>> | undefined;
  const texts = new Map<string, string>();
  let changedLines = new Map<string, Set<number>>(), intentChanged = false;
  try {
    const scope = opts.scope ?? { kind: "declared" as const, paths: opts.intent };
    if (scope.kind === "declared" && !scope.paths.length) throw new Error("intent is required: the list of files the change claimed to touch");
    opts.signal?.throwIfAborted();
    const requestedBase = (await git(opts.checkout, ["rev-parse", "--verify", "--end-of-options", `${opts.base}^{commit}`])).trim();
    workspace = await manifest.time("resolve", () => openWorkspace(opts.checkout, opts.expectedHeadSha, executor.kind === "trusted-local"));
    const repo = workspace.repo, head = workspace.headSha;
    const base = (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`])).trim();
    record.revision = { headSha: head, baseSha: base, scope: scope.kind };
    const changed = await changedFilesFromGit(repo, base);
    const intent = scope.paths;
    const relatedTests = opts.relatedTests?.length ? opts.relatedTests : ["tests"];
    record.audit.tsConfig = readTsConfig(repo);
    if (scope.kind === "inferred" && !intent.length) { record.audit.reasons.push("the change contains no supported program source; no model call was made"); return record; }
    stage = "prepare";
    await manifest.time("prepare", () => executor.prepare(repo));
    const preparationChanges = await changedPaths(repo, head);
    if (preparationChanges.length) throw new Error(`dependency preparation changed the source snapshot: ${preparationChanges.join(", ")}`);
    let visible = scopedReviewFiles(repo, { intentFiles: intent, changedFiles: changed, relatedTests });
    const spark = instrument(opts.sparkClient ?? createModelClient("spark", { cwd: opts.checkout }), "spark", manifest, opts.signal);
    const seeds = new Set([...expandIntentFiles(listClassifiableFiles(repo), intent), ...changed]);
    while (visible.length && !seeds.has(visible.at(-1)!) && estimateTokens(readCheckoutSources(repo, visible).map((s) => s.text).join("\n")) > contextWindow(spark.config.model)) visible = visible.slice(0, -1);
    for (const source of readCheckoutSources(repo, visible)) texts.set(source.file, source.text);
    changedLines = await changedLinesFromGit(repo, base);
    intentChanged = changed.some((f) => matchesIntent(f, intent));
    stage = "classify";
    const classification = await manifest.time("classify", () => classifyFindings({ checkoutDir: repo, files: visible, client: spark, executor,
      ...(scope.kind === "declared" ? { scopeCreep: { changedFiles: changed, intentFiles: intent, baseFileText: (file: string) => readGitFile(repo, base, file) } } : {}) }));
    if ((await changedPaths(repo, head)).length) throw new Error("classification or executable configuration changed the source snapshot");
    record.findings = classification.findings;
    record.findingIds = findingIds(record.findings);
    Object.assign(record.audit, { droppedFindings: classification.dropped.length, recoveredFindings: classification.recovered, registry: classification.registry,
      unknownConventions: classification.unknownConventions, refusedConventions: classification.refusedConventions.map((d) => ({ convention: d.finding.convention ?? "(none)", file: d.finding.file, citations: d.finding.citations, rationale: d.status === "refused" ? d.reason : d.finding.rationale })) });
    record.audit.reasons.push(...classification.scopeExemptions.map((e) => e.reason), ...classification.verificationDropped.map((d) => `finding for ${d.finding.file} kept out of the patch: ${d.reason}`), ...classification.unknownConventions.map((name) => `unknown convention "${name}" in lesscode-conventions.json: ignored`));
    stage = "plan";
    const wonder = instrument(opts.wonderClient ?? createModelClient("wonder", { cwd: opts.checkout }), "wonder", manifest, opts.signal);
    const plan = await manifest.time("plan", () => planOnce({ checkoutDir: repo, findings: record.findings, files: visible, changedFiles: changed, baseRef: base, client: wonder }));
    record.audit.plan = { edits: plan.edits.length, skipped: plan.skipped, model: plan.model, modelCalls: plan.modelCalls, usage: plan.usage, review: plan.review };
    for (const skip of plan.skipped) record.edits.push({ findingId: record.findingIds[skip.findingIndex] ?? `unknown-${skip.findingIndex}`, findingIndex: skip.findingIndex, action: "skip", status: "skipped", files: [], reason: reason("planner-skip", "plan", skip.reason) });
    const candidates: PlannedEdit[] = [...plan.edits];
    for (const [index, f] of record.findings.entries()) if (f.category === "scope-creep" && !candidates.some((e) => e.findingIndex === index)) candidates.push({ findingIndex: index, action: "restore-from-base", newFiles: [], deleteFiles: [], rationale: "code-decided scope creep" });
    const expected = new Map<string, string | null>();
    const restored = new Set(record.findings.filter((f) => f.category === "scope-creep").map((f) => f.file));
    let queue = candidates;
    for (let pass = 0; queue.length && pass <= candidates.length; pass++) {
      const deferred: PlannedEdit[] = [];
      let progress = false;
      for (const edit of queue) {
        opts.signal?.throwIfAborted();
        const finding = record.findings[edit.findingIndex];
        const baseOutcome = { findingId: record.findingIds[edit.findingIndex] ?? `unknown-${edit.findingIndex}`, findingIndex: edit.findingIndex, action: edit.action, files: [] as string[] };
        if (!finding || isTestFile(finding.file) || isSealedPath(finding.file)) { record.edits.push({ ...baseOutcome, status: "skipped", reason: reason("invalid-edit", "prepare", "unknown finding or protected test/sealed path") }); continue; }
        stage = "apply";
        const preparation = await manifest.time("apply", () => prepareEdit({ checkoutDir: repo, baseRef: base, finding, edit, executor }));
        if (preparation.status === "unsupported") {
          if (pass < candidates.length) { deferred.push(edit); continue; }
          record.edits.push({ ...baseOutcome, status: "skipped", reason: reason("unsupported-transform", "prepare", preparation.reason) }); continue;
        }
        const paths = preparation.edit.changes.map((c) => c.path);
        if (!preparation.edit.changes.some((c) => c.before !== c.after)) { record.edits.push({ ...baseOutcome, status: "skipped", reason: reason("unsupported-transform", "prepare", "mechanical edit changed nothing") }); continue; }
        const candidateSet = [...new Set([...expected.keys(), ...paths])];
        const provisional: EditOutcome = { ...baseOutcome, files: paths, status: "kept" };
        stage = "structural";
        const transaction = await manifest.time("gate", () => transactEdit(repo, preparation.edit, async () => {
          const gate = await evaluateCheapGate({ repoDir: repo, baseRef: head, editSet: candidateSet, relatedTests, coverageExempt: candidateSet.filter((p) => restored.has(p)), targetSymbols: await targetedSymbols(repo, head, [...record.edits, provisional], record.findings), executor, signal: opts.signal });
          const keep = gate.accepted || (edit.action === "restore-from-base" && gate.checks.every((c) => c.name === "size-drops" || c.passed));
          return { keep, result: gate };
        }));
        record.gate = transaction.result;
        if (transaction.keep) { record.edits.push(provisional); for (const change of preparation.edit.changes) expected.set(change.path, change.after); progress = true; }
        else {
          const detail = `gate rejected (${transaction.result.checks.filter((c) => !c.passed).map((c) => `${c.name} — ${c.detail}`).join("; ")})`;
          record.edits.push({ ...provisional, status: "rejected", reason: reason("structural-rejection", "structural", detail) });
          record.audit.reasons.push(`finding ${edit.findingIndex} (${edit.action}) dropped: ${detail}`);
        }
      }
      if (!deferred.length) break;
      if (!progress) {
        for (const edit of deferred) record.edits.push({ findingId: record.findingIds[edit.findingIndex]!, findingIndex: edit.findingIndex, action: edit.action, status: "skipped", files: [], reason: reason("unsupported-transform", "prepare", "codemod cannot express this edit safely; prerequisite edits did not apply") });
        break;
      }
      queue = deferred;
    }
    if (!record.edits.some((e) => e.status === "kept")) { record.outcome = record.findings.length || plan.review.length ? "review-only" : "no-change"; return record; }
    stage = "verification";
    const actualPaths = await changedPaths(repo, head);
    const actualSet = new Set(actualPaths);
    if (actualPaths.some((path) => !expected.has(path)) || [...expected].some(([path, text]) => fileText(repo, path) !== text)) throw new Error("candidate tree does not match the committed edit ledger");
    const finalSet = [...expected.keys()].filter((path) => actualSet.has(path));
    const structural = await manifest.time("gate", async () => evaluateCheapGate({ repoDir: repo, baseRef: head, editSet: finalSet, relatedTests, coverageExempt: finalSet.filter((path) => restored.has(path)), targetSymbols: await targetedSymbols(repo, head, record.edits, record.findings), executor, signal: opts.signal }));
    const beforeCommands = await git(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", head, "--"]);
    const commands = await manifest.time("gate", () => evaluateCommandGate({ repoDir: repo, baseRef: head, editSet: finalSet, relatedTests, executor, signal: opts.signal }));
    const afterCommands = await git(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", head, "--"]);
    const commandsChangedSource = beforeCommands !== afterCommands || JSON.stringify(await changedPaths(repo, head)) !== JSON.stringify(actualPaths) || [...expected].some(([path, text]) => fileText(repo, path) !== text);
    const gate: GateResult = { ...commands, accepted: structural.accepted && commands.accepted && !commandsChangedSource, metrics: structural.metrics, checks: [...structural.checks, ...commands.checks, { name: "verified-tree-unchanged", passed: !commandsChangedSource, detail: commandsChangedSource ? "repository commands modified the candidate source; no patch is returned" : "verification ran on exactly the prepared candidate" }] };
    record.gate = gate;
    record.verification.status = gate.accepted ? "verified" : "rejected";
    if (!gate.accepted) {
      const detail = `final gate rejected: ${gate.checks.filter((c) => !c.passed).map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
      for (const edit of record.edits) if (edit.status === "kept") { edit.status = "withdrawn"; edit.reason = reason("verification-failed", "verification", detail); }
      record.audit.reasons.push(detail); record.outcome = "unverified"; return record;
    }
    await git(repo, ["add", "--all", "--", ...finalSet]);
    const treeHash = (await git(repo, ["write-tree"])).trim();
    const patch = await git(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", head, "--"]);
    if (!patch) throw new Error("verified candidate produced an empty patch");
    record.verification.treeHash = treeHash;
    record.artifact = { headSha: head, baseSha: base, patch, sha256: hashText(patch), treeHash, paths: finalSet.sort() };
    record.verdict = "accepted"; record.outcome = "patch-ready";
  } catch (error) {
    record.state = opts.signal?.aborted ? "cancelled" : "failed";
    record.verdict = "failed"; record.outcome = null; record.artifact = null;
    record.failure = { stage, message: error instanceof Error ? error.message : String(error) };
    if (record.gate) record.gate = { ...record.gate, accepted: false, checks: [...record.gate.checks, { name: "run-completed", passed: false, detail: record.failure.message }] };
    record.verification.status = "rejected";
    for (const edit of record.edits) if (edit.status === "kept") { edit.status = "withdrawn"; edit.reason = reason("verification-failed", "verification", record.failure.message); }
  } finally {
    await manifest.time("finalize", async () => finalizeNote(record, texts, changedLines, intentChanged));
    if (workspace) await manifest.time("cleanup", async () => workspace!.dispose());
    if (!opts.executor) await executor.dispose();
    record.execution.environmentId = executor.environmentId;
    record.manifest = manifest.build();
  }
  return record;
}

export function renderRecordSummary(record: RunRecord): string {
  const summary = renderRunSummary({ verdict: record.verdict, findingsKept: record.findings.map((f) => ({ label: `${f.category} in ${f.file}` })),
    findingsDropped: record.audit.reasons.filter((r) => /kept out of|unknown convention/.test(r)).map((r) => ({ label: "finding dropped", reason: r })),
    editsKept: record.edits.filter((e) => e.status === "kept").map((e) => ({ label: `finding ${e.findingIndex}: ${e.action}` })),
    editsDropped: record.edits.filter((e) => e.status !== "kept").map((e) => ({ label: `finding ${e.findingIndex}`, reason: e.reason?.detail ?? e.status })), manifest: record.manifest });
  return record.failure ? `${summary}\nFailed during ${record.failure.stage}: ${record.failure.message}\n` : summary;
}
