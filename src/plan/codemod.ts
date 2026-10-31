import ts from "typescript";
import { isSourceFile, readCheckoutSources } from "../classify/checkout.js";
import { isSealedPath, normaliseRepoPath } from "../classify/evidence.js";
import { parse, type CitedTarget } from "../classify/target.js";

/**
 * AST codemods (LES-21). Wonder still chooses the action per finding
 * in its one call — but for `inline` and `retarget` it no longer
 * writes any file contents. Code performs the mechanical transform
 * with the TypeScript compiler API:
 *
 * - inline: replace the single call site of a verified single-use
 *   wrapper with the forwarded call (substituting the wrapper's
 *   parameters / constructor dependency), then delete the wrapper.
 * - retarget: rewrite every importer of a duplicate helper to import
 *   the existing helper instead, then delete the duplicate.
 *
 * When the transform cannot be expressed as that mechanical edit the
 * function returns `undefined` and the caller *skips* the finding:
 * never fall back to model-written text.
 */

export interface CodemodResult {
  /** Full new contents for files the codemod rewrites. */
  newFiles: { file: string; content: string }[];
  /** Files the codemod deletes (the wrapper / the duplicate). */
  deleteFiles: string[];
}

export type FileSources = Map<string, { sf: ts.SourceFile; text: string }>;

interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping replacements to `text`, or undefined when they overlap. */
export function applyReplacements(text: string, replacements: TextReplacement[]): string | undefined {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return undefined; // overlapping edits are not mechanical
  }
  let out = text;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]!;
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

/**
 * Final text of an edited file: the original text with the codemod's
 * replacements applied — never a printer re-render, which would
 * reformat unrelated statements (and inflate the gate's line count).
 * Only blank runs left by deletions are collapsed.
 */
export function finishText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
}

/** Sources of the checkout as parsed ASTs (never sealed paths; tests included — never scan tests). */
export function loadSources(checkoutDir: string): FileSources {
  const out: FileSources = new Map();
  for (const s of readCheckoutSources(checkoutDir)) {
    const file = normaliseRepoPath(checkoutDir, s.file);
    if (!file || !isSourceFile(file) || isSealedPath(file)) continue;
    out.set(file, { sf: parse(file, s.text), text: s.text });
  }
  return out;
}

/** Resolve a relative import specifier onto a file in the source set. */
export function resolveFrom(fromFile: string, spec: string, sources: FileSources): string | undefined {
  const parts: string[] = [];
  for (const seg of `${fromFile.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const stem = parts.join("/").replace(/\.[cm]?[jt]sx?$/, "");
  for (const cand of [parts.join("/"), ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].flatMap((e) => [`${stem}${e}`, `${stem}/index${e}`])]) {
    if (sources.has(cand)) return cand;
  }
  return undefined;
}

/** Relative specifier from a file's directory to a target, keeping the checkout's `.js` convention. */
function relativeSpecifier(fromFile: string, targetFile: string): string {
  const fromDir = fromFile.split("/").slice(0, -1);
  const targetParts = targetFile.split("/");
  let common = 0;
  while (common < fromDir.length && common < targetParts.length - 1 && fromDir[common] === targetParts[common]) common++;
  const ups = fromDir.length - common;
  const rel = [...Array<string>(ups).fill(".."), ...targetParts.slice(common)].join("/");
  const withExt = /\.[cm]?[jt]sx?$/.test(rel) ? rel.replace(/\.[cm]?tsx?$/, ".js") : `${rel}.js`;
  return ups > 0 ? withExt : `./${withExt}`;
}

/** Import specifiers in `file` that resolve to `targetFile`. */
function specifiersFor(sources: FileSources, file: string, targetFile: string): string[] {
  const entry = sources.get(file);
  if (!entry) return [];
  const specs = new Set<string>();
  for (const stmt of entry.sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith(".")) {
      if (resolveFrom(file, stmt.moduleSpecifier.text, sources) === targetFile) specs.add(stmt.moduleSpecifier.text);
    }
  }
  return [...specs];
}

// ---------------------------------------------------------------------------
// retarget
// ---------------------------------------------------------------------------

/**
 * Every importer of the duplicate helper imports the named helper from
 * `existingHelperFile` instead, and the duplicate is deleted. The
 * existing helper itself is never touched.
 */
export function retargetCodemod(
  duplicate: { name: string; file: string },
  existingHelperFile: string,
  sources: FileSources,
): CodemodResult | undefined {
  const newFiles: { file: string; content: string }[] = [];
  for (const [file, entry] of sources) {
    if (file === duplicate.file) continue;
    const specs = specifiersFor(sources, file, duplicate.file);
    if (!specs.length) continue;
    // Only an importer that actually binds the duplicate's name is
    // retargeted; if any importer uses the spec for other names only,
    // leave it alone and keep scanning.
    const reps: TextReplacement[] = [];
    for (const stmt of entry.sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (!specs.includes(stmt.moduleSpecifier.text)) continue;
      reps.push({
        start: stmt.moduleSpecifier.getStart(entry.sf),
        end: stmt.moduleSpecifier.getEnd(),
        text: JSON.stringify(relativeSpecifier(file, existingHelperFile)),
      });
    }
    if (!reps.length) continue;
    const rewritten = applyReplacements(entry.text, reps);
    if (rewritten === undefined || rewritten === entry.text) return undefined;
    newFiles.push({ file, content: finishText(rewritten) });
  }
  return { newFiles, deleteFiles: [duplicate.file] };
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

interface Member {
  name: string;
  forwarded: ts.CallExpression | ts.NewExpression;
  params: string[];
  ctorParam?: string;
  /** Multi-statement body inlined verbatim (variable bindings + return) when the single call site sits in a statement. */
  bodyStmts?: readonly ts.Statement[];
}

interface Site {
  file: string;
  /** The exact call expression replaced with the forwarded call. */
  expr: ts.CallExpression;
  /** Construction arg for the member's ctor param, as a node in the caller file. */
  ctorDep?: ts.Node;
  /** Call args of the method/function invocation. */
  args: readonly ts.Expression[];
}

/** Local names in `sf` that bind `name` imported from `targetFile`. */
function importBindingsLocal(sf: ts.SourceFile, fromFile: string, sources: FileSources, targetFile: string, name: string): Set<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (resolveFrom(fromFile, stmt.moduleSpecifier.text, sources) !== targetFile) continue;
    const clause = stmt.importClause;
    if (clause?.name && name === "default") out.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if ((el.propertyName ?? el.name).text === name) out.add(el.name.text);
      }
    }
  }
  return out;
}

/**
 * Constructor parameter names of every class in a file. A parameter
 * counts whether or not its class is the one containing the call
 * site: after outer layers are inlined, the surviving class may be
 * reduced to its forwarding method while the wrapper construction
 * (and its deps) still lives in that same class's constructor or a
 * helper — `this.<dep>` is only emitted when the name is found here,
 * and `promoteCtorParam` then attaches it to that constructor. When
 * the surviving constructor is later erased but the dep is read via
 * `this.`, cleanup keeps the constructor (see eraseStoredWrapper).
 */
function survivingCtorParams(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node)) {
      for (const p of node.parameters) if (ts.isIdentifier(p.name)) out.add(p.name.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * Promote a surviving class's constructor parameter to a parameter
 * property (`private readonly x: T`) so `this.x` resolves after the
 * wrapper construction is erased. No-op when it already is one.
 */
function promoteCtorParam(text: string, file: string, names: string[]): string {
  for (const name of names) text = promoteOneCtorParam(text, file, name);
  return text;
}

function promoteOneCtorParam(text: string, file: string, name: string): string {
  const sf = parse(file, text);
  const reps: TextReplacement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node)) {
      for (const p of node.parameters) {
        if (!ts.isIdentifier(p.name) || p.name.text !== name) continue;
        const mods = ts.canHaveModifiers(p) ? ts.getModifiers(p) : undefined;
        if (mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) continue;
        reps.push({ start: p.getStart(sf), end: p.getStart(sf), text: "private readonly " });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return reps.length ? (applyReplacements(text, reps) ?? text) : text;
}

/** Constructor args for an instance expression: `new W(deps)`, a stored `this.f = new W(deps)`, or a variable holding one. */
function resolveCtorArgs(sf: ts.SourceFile, obj: ts.Node, bindings: Set<string>): { ctorDep: ts.Node | undefined; ctorArgs: ts.Node[] } | undefined {
  if (ts.isNewExpression(obj) && ts.isIdentifier(obj.expression) && bindings.has(obj.expression.text)) {
    const args = obj.arguments ? [...obj.arguments] : [];
    return { ctorDep: args[0], ctorArgs: args };
  }
  // this.<field>: find `this.<field> = new W(deps)` anywhere in the file.
  if (ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const field = obj.name.text;
    let found: ts.Node[] | undefined;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.left.name.text === field &&
        ts.isNewExpression(node.right) &&
        ts.isIdentifier(node.right.expression) &&
        bindings.has(node.right.expression.text)
      ) {
        found = node.right.arguments ? [...node.right.arguments] : [];
        return;
      }
      // Parameter-property shorthand: the field is only declared; the
      // construction happens at this class's own call site — resolved
      // by the caller treating this file as the site file.
      node.forEachChild(visit);
    };
    visit(sf);
    return found ? { ctorDep: found[0], ctorArgs: found } : undefined;
  }
  if (ts.isIdentifier(obj)) {
    let found: ts.Node[] | undefined;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === (obj as ts.Identifier).text &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        bindings.has(node.initializer.expression.text)
      ) {
        found = node.initializer.arguments ? [...node.initializer.arguments] : [];
        return;
      }
      node.forEachChild(visit);
    };
    visit(sf);
    return found ? { ctorDep: found[0], ctorArgs: found } : undefined;
  }
  return undefined;
}

/**
 * Totally expand the forwarded expression into the call site's frame:
 * wrapper params → call args, `this.<ctorParam>` → construction dep,
 * callee imported by the wrapper → note the import the caller needs.
 */
interface ForwardResolution {
  text: string;
  neededImport?: { local: string; from: string };
  /** Ctor params rendered as `this.<name>` inside the dep, needing promotion to parameter properties. */
  thisDeps: string[];
  /** For multi-statement bodies: binding statements then the final expression, to splice at the call site. */
  bodyText?: string[];
}

function resolveForward(
  member: Member,
  args: readonly ts.Expression[],
  ctorDep: ts.Node | undefined,
  wrapperSf: ts.SourceFile,
  siteSf: ts.SourceFile,
  wrapperFile: string,
  sources: FileSources,
): ForwardResolution | undefined {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const printIn = (n: ts.Node, sf: ts.SourceFile): string =>
    printer.printNode(ts.EmitHint.Unspecified, n, sf).replace(/\s+/g, " ").trim();

  const paramMap = new Map<string, ts.Expression>();
  member.params.forEach((p, i) => {
    const arg = args[i];
    if (arg) paramMap.set(p, arg);
  });

  let neededImport: { local: string; from: string } | undefined;
  let callee: ts.Node | undefined = (member.forwarded as ts.CallExpression).expression;
  while (callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) callee = callee.expression;
  if (callee && ts.isIdentifier(callee)) {
    // Is the callee imported into the wrapper file from another file?
    for (const stmt of wrapperSf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const targetFile = resolveFrom(wrapperFile, stmt.moduleSpecifier.text, sources);
      const clause = stmt.importClause;
      const binds = (local: string): boolean =>
        local === (callee as ts.Identifier).text && !!targetFile && targetFile !== wrapperFile;
      if (clause?.name && binds(clause.name.text)) {
        neededImport = { local: (callee as ts.Identifier).text, from: targetFile! };
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (binds(el.name.text)) neededImport = { local: el.name.text, from: targetFile! };
        }
      }
    }
  }

  const text0 = member.forwarded.getText(wrapperSf);
  const base = member.forwarded.getStart(wrapperSf);
  const reps: TextReplacement[] = [];
  const thisDeps: string[] = [];
  let ctorText: string | undefined;
  if (member.ctorParam) {
    if (!ctorDep) return undefined;
    // Any identifier inside the dep that is a constructor parameter
    // of the surviving class becomes `this.<name>` (promoted to a
    // parameter property) — a bare identifier would dangle once the
    // wrapper construction (which lived in that constructor) is
    // erased. Covers bare deps and nested constructions alike, e.g.
    // `new UserRepository(new UserApiClient(client))`.
    const ctorParams = survivingCtorParams(siteSf);
    const depBase = ctorDep.getStart(siteSf);
    const depReps: TextReplacement[] = [];
    const visitDep = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isPropName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node));
        if (!isPropName && ctorParams.has(node.text)) {
          depReps.push({ start: node.getStart(siteSf) - depBase, end: node.getEnd() - depBase, text: `this.${node.text}` });
          if (!thisDeps.includes(node.text)) thisDeps.push(node.text);
          return;
        }
      }
      node.forEachChild(visitDep);
    };
    visitDep(ctorDep);
    ctorText = applyReplacements(ctorDep.getText(siteSf), depReps);
    if (ctorText === undefined) return undefined;
    ctorText = ctorText.replace(/\s+/g, " ").trim();
  }
  const visit = (node: ts.Node): void => {
    if (ctorText !== undefined && ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === member.ctorParam) {
      reps.push({ start: node.getStart(wrapperSf) - base, end: node.getEnd() - base, text: ctorText });
      return;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isPropName && paramMap.has(node.text)) {
        reps.push({ start: node.getStart(wrapperSf) - base, end: node.getEnd() - base, text: printIn(paramMap.get(node.text)!, siteSf) });
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(member.forwarded);
  const text = applyReplacements(text0, reps);
  if (text === undefined) return undefined;
  if (!member.bodyStmts) return { text, neededImport, thisDeps };
  // Expand bindings + final return, substituting params in each
  // statement; the caller splices these statements at the call site.
  const expanded: string[] = [];
  for (const stmt of member.bodyStmts) {
    if (ts.isReturnStatement(stmt)) { expanded.push(text); continue; }
    const sText = stmt.getText(wrapperSf);
    const sBase = stmt.getStart(wrapperSf);
    const sReps: TextReplacement[] = [];
    const sVisit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
        const isDeclName = parent && ts.isVariableDeclaration(parent) && parent.name === node;
        if (!isPropName && !isDeclName && paramMap.has(node.text)) {
          sReps.push({ start: node.getStart(wrapperSf) - sBase, end: node.getEnd() - sBase, text: printIn(paramMap.get(node.text)!, siteSf) });
          return;
        }
      }
      node.forEachChild(sVisit);
    };
    sVisit(stmt);
    const out = applyReplacements(sText, sReps);
    if (out === undefined) return undefined;
    expanded.push(out.replace(/\s+/g, " ").trim());
  }
  return { text, neededImport, thisDeps, bodyText: expanded };
}

/**
 * After a stored-instance call is inlined, remove the now-dead field
 * that held the wrapper: its declaration, its (single) assignment,
 * and a constructor left empty by that removal. Returns the cleaned
 * text, or undefined when the field is still used elsewhere.
 */
function eraseStoredWrapper(text: string, file: string, keepCtorFor: string[] = []): string | undefined {
  const sf = parse(file, text);
  let field: string | undefined;
  // Any remaining `this.<field>` read other than through the replaced
  // call means the field is still used; that is checked by counting
  // `this.` property accesses per name after substitution — the
  // caller passes post-substitution text, so a field whose only use
  // was the inlined call no longer appears as `this.<field>.`.
  // Identify candidate fields: declared property whose type/name
  // appears in a `this.<field> =` assignment.
  const assignments = new Map<string, ts.BinaryExpression>();
  const visitAssign = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      assignments.set(node.left.name.text, node);
    }
    node.forEachChild(visitAssign);
  };
  visitAssign(sf);
  if (!assignments.size) return text;

  // A field is dead when `this.<field>` no longer occurs outside its
  // own assignment and declaration.
  const counts = new Map<string, number>();
  const countUses = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      counts.set(node.name.text, (counts.get(node.name.text) ?? 0) + 1);
    }
    node.forEachChild(countUses);
  };
  countUses(sf);

  const reps: TextReplacement[] = [];
  for (const [name, assign] of assignments) {
    if ((counts.get(name) ?? 0) > 1) continue; // still read elsewhere
    field = name;
    // A constructor whose only statement was this assignment is now
    // empty: erase it whole (that also erases the assignment inside
    // it — adding both would be overlapping edits).
    let ctorErased = false;
    for (const top of sf.statements) {
      if (!ts.isClassDeclaration(top)) continue;
      for (const mem of top.members) {
        if (ts.isPropertyDeclaration(mem) && mem.name && ts.isIdentifier(mem.name) && mem.name.text === name) {
          reps.push({ start: mem.getStart(sf), end: mem.getEnd(), text: "" });
        }
        if (ts.isConstructorDeclaration(mem) && mem.body && mem.body.statements.length === 1) {
          const only = mem.body.statements[0]!;
          // Keep the constructor when one of its parameters became
          // the `this.<dep>` the forwarded call now reads — it is
          // promoted to a parameter property instead of erased.
          const keep = mem.parameters.some((p) => ts.isIdentifier(p.name) && keepCtorFor.includes(p.name.text));
          if (!keep && only.getText(sf).includes(`this.${name} =`)) {
            reps.push({ start: mem.getStart(sf), end: mem.getEnd(), text: "" });
            ctorErased = true;
          }
        }
      }
    }
    if (!ctorErased) {
      // Erase the whole assignment statement (walk up to it).
      let stmt: ts.Node = assign;
      while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
      reps.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: "" });
    }
  }
  if (!field) return text;
  const out = applyReplacements(text, reps);
  return out === undefined ? undefined : out.replace(/\n{3,}/g, "\n\n");
}

/** Exported top-level names of a file. */
function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if ((ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) && stmt.name) names.push(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    }
  }
  return names;
}

/**
 * The `inline` codemod for the cited wrapper `target` in
 * `wrapperFile`. See the module header for the skip conditions.
 */
export function inlineCodemod(
  target: CitedTarget,
  wrapperFile: string,
  sources: FileSources,
): CodemodResult | undefined {
  const entry = sources.get(wrapperFile);
  if (!entry) return undefined;
  const decl = target.decl;
  const wrapperSf = entry.sf;

  // Wrapper members: every method (or the function itself) must be a
  // single return forwarding to one call — re-verified here so the
  // codemod never trusts a stale or broader citation.
  const members: Member[] = [];
  let ctorParamNames: string[] = [];
  const isClass = ts.isClassDeclaration(decl);
  if (isClass) {
    for (const m of decl.members) {
      if (ts.isConstructorDeclaration(m)) {
        ctorParamNames = m.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
        if (ctorParamNames.some((p) => !p)) return undefined;
        continue;
      }
      if (!ts.isMethodDeclaration(m) || !m.body || !m.name || !ts.isIdentifier(m.name)) return undefined;
      if (m.parameters.some((p) => !ts.isIdentifier(p.name))) return undefined;
      const only = m.body.statements.length === 1 ? m.body.statements[0] : undefined;
      if (!only || !ts.isReturnStatement(only) || !only.expression) return undefined;
      let e: ts.Node = only.expression;
      while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
      if (!ts.isCallExpression(e) && !ts.isNewExpression(e)) return undefined;
      // Which constructor parameter does `this.<x>` refer to?
      let ctorParam: string | undefined;
      let chain: ts.Node = (e as ts.CallExpression | ts.NewExpression).expression;
      while (ts.isPropertyAccessExpression(chain) && chain.expression.kind !== ts.SyntaxKind.ThisKeyword) chain = chain.expression;
      if (ts.isPropertyAccessExpression(chain) && chain.expression.kind === ts.SyntaxKind.ThisKeyword) {
        ctorParam = ctorParamNames.includes(chain.name.text) ? chain.name.text : undefined;
        if (!ctorParam) return undefined;
      }
      members.push({
        name: m.name.text,
        forwarded: e as ts.CallExpression | ts.NewExpression,
        params: m.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "")),
        ctorParam,
      });
    }
    if (!members.length) return undefined;
  } else {
    let body: ts.Node | undefined;
    let params: string[] = [];
    if (ts.isFunctionDeclaration(decl)) {
      body = decl.body;
      params = decl.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
    } else if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
    ) {
      body = decl.initializer.body;
      params = decl.initializer.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
    }
    if (!body || params.some((p) => !p)) return undefined;
    let e: ts.Node;
    let bodyStmts: readonly ts.Statement[] | undefined;
    if (ts.isBlock(body)) {
      const only = body.statements.length === 1 ? body.statements[0] : undefined;
      if (only && ts.isReturnStatement(only) && only.expression) {
        e = only.expression;
      } else if (
        body.statements.length > 1 &&
        body.statements.slice(0, -1).every((s) => ts.isVariableStatement(s)) &&
        ts.isReturnStatement(body.statements.at(-1)!) &&
        (body.statements.at(-1) as ts.ReturnStatement).expression
      ) {
        // e.g. lineTotal: `const rate = f(line); return <expr using rate>;`
        bodyStmts = body.statements;
        e = (body.statements.at(-1) as ts.ReturnStatement).expression!;
      } else return undefined;
    } else {
      e = body;
    }
    while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    if (!bodyStmts && !ts.isCallExpression(e) && !ts.isNewExpression(e)) return undefined;
    members.push({ name: target.name, forwarded: e as ts.CallExpression | ts.NewExpression, params, bodyStmts });
  }

  // Collect ALL uses of the wrapper symbol across the checkout. The
  // codemod requires exactly one *invoke* site; constructions that
  // only feed that invocation (fixtures: `new UserService(new Repo)`)
  // are part of it, while any other reference blocks the edit. The
  // wrapper file ITSELF is also scanned: after an inner layer was
  // inlined, the surviving outer wrapper forwards through the
  // wrapper name in its own body (`return this.api.fetchUser(id)`),
  // which is a same-file call site with `decl === wrapper`.
  const callSites: { site: Site; member: Member }[] = [];
  for (const [file, src] of sources) {
    const sameFile = file === wrapperFile;
    const bindings = sameFile
      ? new Set([target.name])
      : importBindingsLocal(src.sf, file, sources, wrapperFile, target.name);
    if (!bindings.size) continue;
    const visit = (node: ts.Node): void => {
      if (isClass && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const member = members.find((m) => m.name === (node.expression as ts.PropertyAccessExpression).name.text);
        if (member) {
          const resolved = resolveCtorArgs(src.sf, node.expression.expression, bindings);
          if (resolved) {
            callSites.push({
              member,
              site: {
                file,
                expr: node,
                ctorDep: member.ctorParam ? resolved.ctorArgs[ctorParamNames.indexOf(member.ctorParam)] : undefined,
                args: node.arguments,
              },
            });
          }
        }
      }
      if (!isClass && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.has(node.expression.text)) {
        callSites.push({ member: members[0]!, site: { file, expr: node, args: node.arguments } });
      }
      node.forEachChild(visit);
    };
    visit(src.sf);
  }
  if (callSites.length !== 1) return undefined;
  const { site, member } = callSites[0]!;
  const siteEntry = sources.get(site.file);
  if (!siteEntry) return undefined;

  // A wrapper chain (fixture 1) only inlines outermost-first: the
  // inner layers' call sites become expressible once the outer
  // wrapper's construction is substituted into the surviving caller.
  // `applyPlan` therefore defers a codemod that returns undefined
  // here and retries it after the other edits of the run applied.
  //
  // `this.<ctorParam>` in a *stored-instance* caller (fixture 1 chain):
  // the caller's class stores the wrapper in a field and the wrapper
  // stores its dep; the substitution needs the dep the CALLER passes
  // when constructing the wrapper. That's the caller file's own
  // constructor argument for that field — recovered by following
  // `this.<field> = new W(dep)` in the caller and using dep's text.
  // resolveCtorArgs above already followed it: it returns the
  // construction args from the caller's file.
  const resolved = resolveForward(member, site.args, site.ctorDep, wrapperSf, siteEntry.sf, wrapperFile, sources);
  if (resolved === undefined) return undefined;

  // Replace the single call expression in the caller text. For a
  // multi-statement body spliced into an expression statement
  // (`total += lineTotal(line);`), rewrite it as bindings + the
  // final expression in place of that statement.
  let splice: { start: number; end: number; text: string } | undefined;
  if (resolved.bodyText) {
    let stmt: ts.Node = site.expr;
    while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
    if (!ts.isExpressionStatement(stmt) && !ts.isReturnStatement(stmt)) return undefined;
    const bindings = resolved.bodyText.slice(0, -1);
    const finalExpr = resolved.bodyText.at(-1)!;
    const indent = siteEntry.text.slice(siteEntry.text.lastIndexOf("\n", stmt.getStart(siteEntry.sf) - 1) + 1, stmt.getStart(siteEntry.sf));
    const stmtText = ts.isReturnStatement(stmt)
      ? [...bindings, `return ${finalExpr};`].join(`\n${indent}`)
      : [...bindings, stmt.getText(siteEntry.sf).replace(site.expr.getText(siteEntry.sf), finalExpr)].join(`\n${indent}`);
    splice = { start: stmt.getStart(siteEntry.sf), end: stmt.getEnd(), text: stmtText };
  }
  let callerText = applyReplacements(siteEntry.text, [
    splice ?? { start: site.expr.getStart(siteEntry.sf), end: site.expr.getEnd(), text: resolved.text },
  ]);
  if (callerText === undefined) return undefined;

  const sameFile = site.file === wrapperFile;

  // Drop the wrapper import from the caller (it must bind only the
  // wrapper name; a shared import is not a mechanical edit).
  if (!sameFile) {
    const sf1 = parse(site.file, callerText);
    let removed: string | undefined;
    for (const stmt of sf1.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (resolveFrom(site.file, stmt.moduleSpecifier.text, sources) !== wrapperFile) continue;
      const clause = stmt.importClause;
      const bound: { local: string; orig: string }[] = [];
      if (clause?.name) bound.push({ local: clause.name.text, orig: "default" });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) bound.push({ local: el.name.text, orig: (el.propertyName ?? el.name).text });
      }
      // Only proceed when the single bound name is the wrapper's.
      if (bound.length !== 1 || bound[0]!.orig !== target.name) return undefined;
      const lineStart = callerText.lastIndexOf("\n", stmt.getStart(sf1) - 1) + 1;
      const nl = callerText.indexOf("\n", stmt.getEnd());
      removed = callerText.slice(0, lineStart) + callerText.slice(nl === -1 ? callerText.length : nl + 1);
      break;
    }
    // No import to remove is fine (same-file wrappers never reach
    // here — the wrapper file is a different file by construction).
    if (removed !== undefined) callerText = removed;
  }

  // The forwarded callee may need importing into the surviving caller.
  if (resolved.neededImport) {
    callerText = `import { ${resolved.neededImport.local} } from ${JSON.stringify(relativeSpecifier(site.file, resolved.neededImport.from))};\n` + callerText;
  }

  // Stored-instance cleanup: when the caller's class stores the
  // wrapper in a field that nothing else uses now the call is inlined
  // (`private readonly service: UserService;` plus its assignment),
  // erase the declaration, the assignment, and any now-empty
  // constructor, so the dead `new Wrapper(...)` construction (whose
  // dependency expression the substitution already consumed) does
  // not linger or trip tsc. Operates on the post-substitution text.
  const receiver = site.expr.expression;
  if (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const cleaned = eraseStoredWrapper(callerText, site.file, resolved.thisDeps);
    if (cleaned === undefined) return undefined;
    callerText = cleaned;
  }

  // When the forwarded call now reads `this.<dep>` (bare-identifier
  // dep promoted by resolveForward), make sure the surviving class
  // actually holds that dep as a parameter property.
  if (resolved.thisDeps.length) callerText = promoteCtorParam(callerText, site.file, resolved.thisDeps);

  // Deleting the wrapper is only safe when nothing else it exports
  // is still imported anywhere (the gate checks exports too; refuse
  // early rather than produce a broken tree).
  // (Same-file: only the targeted declaration is deleted; other
  // exports of the file stay, so this check does not apply.)
  if (!sameFile) for (const name of exportedNames(wrapperSf)) {
    if (name === target.name) continue;
    for (const [file, src] of sources) {
      if (file === wrapperFile || file === site.file) continue;
      if (importBindingsLocal(src.sf, file, sources, wrapperFile, name).size) return undefined;
    }
  }

  if (sameFile) {
    // Wrapper and its sole call site share a file (fixture 5 pricing
    // helpers): delete just the targeted declaration, keep the file.
    const sf2 = parse(site.file, callerText);
    // Locate the declaration again by name (positions shifted).
    let declNode: ts.Node | undefined;
    for (const stmt of sf2.statements) {
      const candidates: ts.Node[] = ts.isVariableStatement(stmt) ? [...stmt.declarationList.declarations] : [stmt];
      for (const c of candidates) {
        const n = (ts.isFunctionDeclaration(c) || ts.isClassDeclaration(c) || ts.isVariableDeclaration(c)) && c.name && ts.isIdentifier(c.name) ? c.name.text : undefined;
        if (n === target.name) { declNode = ts.isVariableDeclaration(c) ? stmt : c; break; }
      }
      if (declNode) break;
    }
    if (!declNode) return undefined;
    const without = applyReplacements(callerText, [{ start: declNode.getStart(sf2), end: declNode.getEnd(), text: "" }]);
    if (without === undefined) return undefined;
    return { newFiles: [{ file: site.file, content: finishText(without) }], deleteFiles: [] };
  }

  return { newFiles: [{ file: site.file, content: finishText(callerText) }], deleteFiles: [wrapperFile] };
}

