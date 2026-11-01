import ts from "typescript";
import { buildSymbolGraph, importersOf } from "../gate/symbolGraph.js";
import { isSourceFile, readCheckoutSources } from "./checkout.js";
import { filterByEvidence, isSealedPath, normaliseRepoPath } from "./evidence.js";
import type { Citation, Finding } from "./schema.js";
import { declName, parse, topLevelDecls } from "./target.js";

/**
 * Citation recovery (LES-30): before the evidence filter drops a model
 * finding whole for a numbering slip, try to recover it in code.
 *
 * The model already named the file; recovery never leaves that file and
 * never invents a finding. It searches the cited file for the symbol the
 * finding is about — named in the rationale or at a cited line — and,
 * when exactly one declaration matches, rewrites the citations to that
 * declaration and its call sites (in the files the symbol graph says
 * import the cited file, plus the cited file itself). When nothing
 * matches, or more than one declaration does, the finding is dropped
 * exactly as before. No model call is made.
 */

export interface RecoveredFinding {
  /** The kept finding, with its citations rewritten. */
  finding: Finding;
  /** Symbol whose unique declaration the citations were moved to. */
  symbol: string;
  /** File the model named (and recovery stayed inside). */
  file: string;
  /** Citations as the model reported them. */
  originalCitations: Citation[];
  /** Citations after recovery: the declaration and its call sites. */
  citations: Citation[];
}

export interface RecoveryResult {
  kept: Finding[];
  dropped: Finding[];
  recovered: RecoveredFinding[];
}

interface Candidate {
  name: string;
  className?: string;
  decl: ts.Node;
}

function lineRange(sf: ts.SourceFile, node: ts.Node): Citation["startLine"] extends never ? never : { startLine: number; endLine: number } {
  let n = node;
  // A variable declaration's range should cover its whole statement.
  if (ts.isVariableDeclaration(n) && ts.isVariableDeclarationList(n.parent) && ts.isVariableStatement(n.parent.parent)) n = n.parent.parent;
  return {
    startLine: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
    endLine: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
  };
}

/** Every named declaration in a file: top-level declarations plus class methods. */
function candidates(sf: ts.SourceFile): Candidate[] {
  const out: Candidate[] = [];
  for (const node of topLevelDecls(sf)) {
    const name = declName(node);
    if (name) out.push({ name, decl: node });
    if (ts.isClassDeclaration(node) && node.name) {
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) out.push({ name: m.name.text, className: node.name.text, decl: m });
      }
    }
  }
  return out;
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Symbol name(s) the finding is about, and whether it explicitly names
 * a symbol at all. Names come from the rationale and from the source
 * lines the (possibly mis-numbered) citations do point at. An explicit
 * name is a capitalised or backticked identifier — prose like
 * "wrapper used once" names no symbol.
 */
function namedSymbols(checkoutDir: string, finding: Finding, texts: Map<string, string>): { names: Set<string>; explicit: boolean } {
  const names = new Set<string>();
  let explicit = false;
  const scan = (text: string, markExplicit: boolean): void => {
    for (const m of text.matchAll(IDENT)) {
      names.add(m[0]);
      if (markExplicit && (/^[A-Z]/.test(m[0]) || /^[a-z]+[A-Z]/.test(m[0]))) explicit = true;
    }
    for (const m of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) { names.add(m[1]!); explicit = true; }
  };
  scan(finding.rationale, true);
  for (const c of finding.citations) {
    const text = texts.get(c.file);
    if (!text) continue;
    const lines = text.split("\n");
    scan(lines.slice(Math.max(0, c.startLine - 1), c.endLine).join("\n"), true);
  }
  void checkoutDir;
  return { names, explicit };
}

/** Local binding name -> {file, original name} for relative imports in one file. */
function importBindings(sf: ts.SourceFile, fromFile: string, files: Set<string>): Map<string, { file: string; name: string }> {
  const resolveSpec = (spec: string): string | undefined => {
    const parts: string[] = [];
    for (const seg of `${fromFile.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg !== "") parts.push(seg);
    }
    const stem = parts.join("/").replace(/\.[cm]?[jt]sx?$/, "");
    for (const cand of [parts.join("/"), ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].flatMap((e) => [`${stem}${e}`, `${stem}/index${e}`])]) {
      if (files.has(cand)) return cand;
    }
    return undefined;
  };
  const out = new Map<string, { file: string; name: string }>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
      const target = resolveSpec(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (target && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) out.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
      }
      if (target && clause?.name) out.set(clause.name.text, { file: target, name: "default" });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Citations for every call/new site of `target` in the given files, as code sees them. */
function callSiteCitations(sources: Map<string, ts.SourceFile>, target: Candidate & { file: string }, filesToScan: Set<string>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const files = new Set(sources.keys());
  for (const [file, sf] of sources) {
    if (!filesToScan.has(file)) continue;
    const bindings = importBindings(sf, file, files);
    const isTargetBinding = (id: ts.Identifier): boolean => {
      if (target.className) return false;
      if (file === target.file && id.text === target.name && !bindings.has(id.text)) return true;
      const b = bindings.get(id.text);
      return b?.file === target.file && b.name === target.name;
    };
    const visit = (node: ts.Node): void => {
      if (node !== target.decl && (ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression) {
        const expr = node.expression;
        const hit =
          (ts.isIdentifier(expr) && isTargetBinding(expr)) ||
          (target.className !== undefined && ts.isPropertyAccessExpression(expr) && expr.name.text === target.name) ||
          (target.className !== undefined && ts.isIdentifier(expr) && file === target.file && expr.text === target.className) ||
          (!target.className && ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && bindings.get(expr.expression.text)?.file === target.file && expr.name.text === target.name);
        if (hit) {
          const r = lineRange(sf, node);
          const key = `${file}:${r.startLine}-${r.endLine}`;
          if (!seen.has(key)) { seen.add(key); out.push({ file, ...r }); }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

function recoverOne(checkoutDir: string, finding: Finding, sources: Map<string, ts.SourceFile>, texts: Map<string, string>): RecoveredFinding | undefined {
  const file = normaliseRepoPath(checkoutDir, finding.file);
  if (file === undefined || isSealedPath(file) || !isSourceFile(file)) return undefined;
  if (finding.citations.some((c) => isSealedPath(c.file.replace(/\\/g, "/")))) return undefined;
  const sf = sources.get(file);
  if (!sf) return undefined; // missing / unreadable file: drop as today

  const decls = candidates(sf);
  if (!decls.length) return undefined;
  const { names, explicit } = namedSymbols(checkoutDir, finding, texts);
  let matches = decls.filter((d) => names.has(d.name));
  // A class and its method both named in prose are one target: the method.
  if (matches.length > 1) {
    const methods = matches.filter((m) => m.className && matches.some((c) => !c.className && c.name === m.className));
    if (methods.length === 1) matches = methods;
  }
  let target: Candidate | undefined;
  if (matches.length === 1) target = matches[0];
  else if (matches.length === 0 && !explicit && decls.length === 1) target = decls[0];
  if (!target) return undefined; // nothing matches, or more than one does: drop as today

  // Call sites as the symbol graph sees them: files the checker says
  // import the cited file, plus the cited file itself.
  let filesToScan = new Set<string>([file, ...sources.keys()]);
  try {
    const graph = buildSymbolGraph(texts);
    filesToScan = new Set([file, ...importersOf(graph, file)]);
  } catch { /* graph unavailable: scan the checkout */ }

  const citations: Citation[] = [
    { file, ...lineRange(sf, target.decl) },
    ...callSiteCitations(sources, { ...target, file }, filesToScan),
  ];
  const recoveredFinding: Finding = { ...finding, file, citations };
  // Recovery may only move a citation; the rewritten finding must pass
  // the same evidence check the original failed.
  if (!filterByEvidence(checkoutDir, [recoveredFinding]).length) return undefined;
  return { finding: recoveredFinding, symbol: target.name, file, originalCitations: finding.citations, citations };
}

/**
 * Evidence filter with recovery: findings that pass are kept as-is;
 * findings that fail get one code-only recovery attempt each before
 * they are dropped.
 */
export function recoverFindings(checkoutDir: string, findings: readonly Finding[]): RecoveryResult {
  const keptSet = new Set(filterByEvidence(checkoutDir, findings));
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  const recovered: RecoveredFinding[] = [];
  let sources: Map<string, ts.SourceFile> | undefined;
  let texts: Map<string, string> | undefined;
  for (const finding of findings) {
    if (keptSet.has(finding)) { kept.push(finding); continue; }
    if (!sources || !texts) {
      sources = new Map(); texts = new Map();
      for (const s of readCheckoutSources(checkoutDir)) {
        if (!isSourceFile(s.file) || isSealedPath(s.file)) continue;
        sources.set(s.file, parse(s.file, s.text));
        texts.set(s.file, s.text);
      }
    }
    const r = recoverOne(checkoutDir, finding, sources, texts);
    if (r) { kept.push(r.finding); recovered.push(r); }
    else dropped.push(finding);
  }
  return { kept, dropped, recovered };
}
