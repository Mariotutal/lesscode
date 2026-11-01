import ts from "typescript";
import { isSourceFile, readCheckoutSources } from "../classify/checkout.js";
import { isSealedPath, normaliseRepoPath } from "../classify/evidence.js";
import { declName, parse, topLevelDecls, type CitedTarget } from "../classify/target.js";
import { bindingIdentity, createBindingContext, equivalentHelperReason } from "../classify/verify.js";

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
  return text.endsWith("\n") ? text : `${text}\n`;
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

/** Semantic refusal is separate from application or gate failure. */
export function retargetSafetyReason(duplicate: { name: string; file: string }, existingHelperFile: string, sources: FileSources): string | undefined {
  const duplicateSource = sources.get(duplicate.file)?.sf, existingSource = sources.get(existingHelperFile)?.sf;
  if (!duplicateSource || !existingSource || duplicate.file === existingHelperFile) return "duplicate and existing helper must name different readable modules";
  const a = topLevelDecls(duplicateSource).find((node) => declName(node) === duplicate.name);
  const b = topLevelDecls(existingSource).find((node) => declName(node) === duplicate.name);
  if (!a || !b) return "both modules must declare the same named helper";
  const mismatch = equivalentHelperReason(a, b, new Map([...sources].map(([file, value]) => [file, value.sf])));
  if (mismatch) return `helpers are not equivalent: ${mismatch}`;
  for (const [sf, target] of [[duplicateSource, a], [existingSource, b]] as const) {
    for (const statement of sf.statements) {
      if (statement === target || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 && statement.declarationList.declarations[0] === target) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      return "retargeting modules with additional runtime declarations or imports requires a module-effect proof";
    }
  }
  let unsupported: string | undefined;
  for (const [file, entry] of sources) {
    const scan = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && resolveFrom(file, node.moduleSpecifier.text, sources) === duplicate.file) {
        if (!ts.isImportDeclaration(node) || !node.importClause) unsupported = "re-exports or side-effect-only imports cannot be retargeted";
        else {
          const clause = node.importClause;
          if (clause.namedBindings && (!ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.some((el) => (el.propertyName ?? el.name).text !== duplicate.name))) unsupported = "namespace or mixed-name imports cannot be retargeted by changing a module specifier";
          if (clause.name && !(ts.canHaveModifiers(a) && ts.getModifiers(a)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))) unsupported = "a default import does not bind the named helper";
        }
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && resolveFrom(file, node.arguments[0].text, sources) === duplicate.file) unsupported = "dynamic imports or require references cannot be retargeted";
      node.forEachChild(scan);
    };
    scan(entry.sf);
  }
  return unsupported;
}

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
  if (retargetSafetyReason(duplicate, existingHelperFile, sources)) return undefined;
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
  forwarded: ts.Expression;
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
  ctorArgs?: readonly ts.Node[];
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
    let owner: ts.Node | undefined = obj;
    while (owner && !ts.isClassDeclaration(owner)) owner = owner.parent;
    if (owner) visit(owner);
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
  neededImport?: { local: string; imported: string; from: string };
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
  const argumentText = (n: ts.Node, sf: ts.SourceFile): string => {
    const text = printer.printNode(ts.EmitHint.Unspecified, n, sf);
    return ts.isBinaryExpression(n) || ts.isConditionalExpression(n) || ts.isCommaListExpression(n) ? `(${text})` : text;
  };

  const paramMap = new Map<string, ts.Expression>();
  member.params.forEach((p, i) => {
    const arg = args[i];
    if (arg) paramMap.set(p, arg);
  });

  let neededImport: { local: string; imported: string; from: string } | undefined;
  let callee: ts.Node | undefined = ts.isCallExpression(member.forwarded) || ts.isNewExpression(member.forwarded) ? member.forwarded.expression : undefined;
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
        neededImport = { local: (callee as ts.Identifier).text, imported: "default", from: targetFile! };
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (binds(el.name.text)) neededImport = { local: el.name.text, imported: (el.propertyName ?? el.name).text, from: targetFile! };
        }
      }
    }
  }

  if (neededImport && (wrapperSf === siteSf || siteSf.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || resolveFrom(siteSf.fileName, statement.moduleSpecifier.text, sources) !== neededImport!.from) return false;
    const clause = statement.importClause;
    return neededImport!.imported === "default" ? clause?.name?.text === neededImport!.local : !!clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((el) => el.name.text === neededImport!.local && (el.propertyName ?? el.name).text === neededImport!.imported);
  }))) neededImport = undefined;

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
    if (ts.isBinaryExpression(ctorDep) || ts.isConditionalExpression(ctorDep) || ts.isArrowFunction(ctorDep) || ts.isFunctionExpression(ctorDep)) ctorText = `(${ctorText})`;

  }
  const visit = (node: ts.Node): void => {
    if (ctorText !== undefined && ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === member.ctorParam) {
      reps.push({ start: node.getStart(wrapperSf) - base, end: node.getEnd() - base, text: ctorText });
      return;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node));
      if (!isPropName && !isTypePosition(node) && paramMap.has(node.text)) {
        const value = argumentText(paramMap.get(node.text)!, siteSf);
        reps.push({ start: node.getStart(wrapperSf) - base, end: node.getEnd() - base, text: parent && ts.isShorthandPropertyAssignment(parent) ? `${node.text}: ${value}` : value });
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
        const isPropName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node));
        const isDeclName = parent && ts.isVariableDeclaration(parent) && parent.name === node;
        if (!isPropName && !isDeclName && !isTypePosition(node) && paramMap.has(node.text)) {
          const value = argumentText(paramMap.get(node.text)!, siteSf);
          sReps.push({ start: node.getStart(wrapperSf) - sBase, end: node.getEnd() - sBase, text: parent && ts.isShorthandPropertyAssignment(parent) ? `${node.text}: ${value}` : value });
          return;
        }
      }
      node.forEachChild(sVisit);
    };
    sVisit(stmt);
    const out = applyReplacements(sText, sReps);
    if (out === undefined) return undefined;
    expanded.push(out);
  }
  return { text, neededImport, thisDeps, bodyText: expanded };
}

/**
 * After a stored-instance call is inlined, remove the now-dead field
 * that held the wrapper: its declaration, its (single) assignment,
 * and a constructor left empty by that removal. Returns the cleaned
 * text, or undefined when the field is still used elsewhere.
 */
function eraseStoredWrapper(text: string, file: string, targetField: string, keepCtorFor: string[] = []): string | undefined {
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
    if (name !== targetField) continue;
    if ((counts.get(name) ?? 0) > 1) return undefined; // another read would keep the instance alive
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
  return out;
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

interface InlineAnalysis {
  callSites: { site: Site; member: Member }[];
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
  return undefined;
}

function parameterReason(parameters: readonly ts.ParameterDeclaration[]): string | undefined {
  if (parameters.some((p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken || p.questionToken || p.name.getText() === "this" || ts.getDecorators(p)?.length)) {
    return "default, optional, rest, destructured, this, or decorated parameters need a separate argument-binding transform";
  }
  return undefined;
}

function transparentClassReason(decl: ts.ClassDeclaration): string | undefined {
  if (decl.heritageClauses?.length || ts.getDecorators(decl)?.length) return "inherited or decorated constructors are not transparent";
  for (const member of decl.members) {
    if (ts.isConstructorDeclaration(member)) {
      if (member.body?.statements.length || parameterReason(member.parameters)) return "constructor effects or nontrivial parameter initialization would be removed";
    } else if (!ts.isMethodDeclaration(member) || member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) || ts.getDecorators(member)?.length) {
      return "class fields, accessors, static members, or decorators are not transparent";
    } else {
      const only = member.body?.statements.length === 1 ? member.body.statements[0] : undefined;
      if (!only || !ts.isReturnStatement(only) || !only.expression || (!ts.isCallExpression(only.expression) && !ts.isNewExpression(only.expression))) return "dependency methods must be transparent forwards";
      let mutates = false;
      const scan = (n: ts.Node): void => {
        if ((ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ts.isPostfixUnaryExpression(n) || (ts.isPrefixUnaryExpression(n) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator))) mutates = true;
        n.forEachChild(scan);
      };
      scan(only.expression);
      if (mutates) return "dependency methods mutate state";
    }
  }
  return undefined;
}

/** A stable local value can be read again without triggering getters, coercion or mutation. */
function stableArgument(node: ts.Expression, site: ts.Node, checker: ts.TypeChecker): boolean {
  if (ts.isParenthesizedExpression(node)) return stableArgument(node.expression, site, checker);
  if (ts.isLiteralExpression(node) && !ts.isRegularExpressionLiteral(node)) return true;
  if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return true;
  if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(node.operator)) return ts.isNumericLiteral(node.operand);
  if (ts.isBinaryExpression(node)) {
    const numeric = (n: ts.Expression): boolean => ts.isNumericLiteral(n) || (ts.isParenthesizedExpression(n) && numeric(n.expression)) || (ts.isBinaryExpression(n) && numeric(n.left) && numeric(n.right));
    return numeric(node) && ![ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
  }
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const property = checker.getSymbolAtLocation(node.name)?.valueDeclaration;
    return !!property && ts.isParameter(property) && !!property.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || enclosingFunction(declaration) !== enclosingFunction(site)) return false;
  if (ts.isVariableDeclaration(declaration)) {
    if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const) || declaration.getStart() > site.getStart()) return false;
  } else if (!ts.isParameter(declaration)) return false;
  let written = false;
  const scan = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === symbol) {
      const p = n.parent;
      if ((ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ts.isPostfixUnaryExpression(p) || (ts.isPrefixUnaryExpression(p) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator))) written = true;
    }
    n.forEachChild(scan);
  };
  scan(site.getSourceFile());
  return !written;
}

function isTypePosition(node: ts.Node): boolean {
  for (let p = node.parent; p && !ts.isStatement(p); p = p.parent) if (ts.isTypeNode(p)) return true;
  return false;
}

/** Return the exact unsupported semantic feature instead of implying a gate failure. */
export function inlineSafetyReason(target: CitedTarget, wrapperFile: string, sources: FileSources): string | undefined {
  const analysis = analyseInline(target, wrapperFile, sources);
  return typeof analysis === "string" ? analysis : undefined;
}

function analyseInline(target: CitedTarget, wrapperFile: string, sources: FileSources): InlineAnalysis | string {
  const entry = sources.get(wrapperFile);
  if (!entry) return "wrapper source is not present in this snapshot";
  const declaration = target.decl;
  const members: Member[] = [];
  let ctorParamNames: string[] = [];
  const isClass = ts.isClassDeclaration(declaration);
  const addMember = (name: string, fn: ts.FunctionLikeDeclaration): string | undefined => {
    if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken) return "async and generator wrappers cannot be replaced by a synchronous expression";
    const invalid = parameterReason(fn.parameters);
    if (invalid) return invalid;
    const body = fn.body;
    if (!body) return "wrapper has no implementation";
    let forwarded: ts.Expression;
    let bodyStmts: readonly ts.Statement[] | undefined;
    if (ts.isBlock(body)) {
      const last = body.statements.at(-1);
      if (!last || !ts.isReturnStatement(last) || !last.expression) return "wrapper must end with a concrete returned expression";
      if (body.statements.length > 1) {
        if (isClass || !body.statements.slice(0, -1).every((s) => ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const))) return "only same-scope const bindings followed by return can be spliced";
        bodyStmts = body.statements;
      }
      forwarded = last.expression;
    } else forwarded = body;
    if (ts.isAwaitExpression(forwarded)) return "await changes error timing and promise adoption";
    while (ts.isParenthesizedExpression(forwarded)) forwarded = forwarded.expression;
    if (!bodyStmts && !ts.isCallExpression(forwarded) && !ts.isNewExpression(forwarded)) return "wrapper does not forward one call";
    if ((ts.isCallExpression(forwarded) && forwarded.questionDotToken) || fn.parameters.some((p) => !ts.isIdentifier(p.name))) return "optional invocation or destructured parameters are unsupported";
    let ctorParam: string | undefined;
    if (isClass && (ts.isCallExpression(forwarded) || ts.isNewExpression(forwarded))) {
      let receiver: ts.Node = forwarded.expression;
      while (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) receiver = receiver.expression;
      if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
        if (!ctorParamNames.includes(receiver.name.text)) return "method uses state other than a constructor parameter property";
        ctorParam = receiver.name.text;
        const ctor = (declaration as ts.ClassDeclaration).members.find(ts.isConstructorDeclaration);
        const property = ctor?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === ctorParam);
        if (!property?.modifiers?.some((m) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(m.kind))) return "receiver is not an initialized constructor parameter property";
      }
    }
    let unsafe: string | undefined;
    const scan = (node: ts.Node): void => {
      if (node !== body && (ts.isFunctionLike(node) || ts.isClassLike(node))) { unsafe = "nested functions or classes introduce a separate lexical scope"; return; }
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isMetaProperty(node) || node.kind === ts.SyntaxKind.SuperKeyword || (ts.isIdentifier(node) && ["arguments", "eval"].includes(node.text))) unsafe = "context-dependent arguments, eval, await, yield, super, or new.target cannot be moved";
      if (node.kind === ts.SyntaxKind.ThisKeyword && !(ctorParam && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === ctorParam)) unsafe = "this would acquire the caller's binding";
      node.forEachChild(scan);
    };
    scan(body);
    if (unsafe) return unsafe;
    members.push({ name, forwarded, params: fn.parameters.map((p) => (p.name as ts.Identifier).text), ctorParam, bodyStmts });
    return undefined;
  };
  if (isClass) {
    const invalid = transparentClassReason(declaration);
    if (invalid) return invalid;
    const ctor = declaration.members.find(ts.isConstructorDeclaration);
    ctorParamNames = ctor?.parameters.map((p) => (p.name as ts.Identifier).text) ?? [];
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member)) continue;
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) return "only named instance methods are supported";
      const invalid = addMember(member.name.text, member);
      if (invalid) return invalid;
    }
  } else {
    const fn = ts.isFunctionDeclaration(declaration) ? declaration : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
    if (!fn) return "only whole forwarding functions or classes can be inlined";
    const invalid = addMember(target.name, fn);
    if (invalid) return invalid;
  }
  if (!members.length) return "class has no forwarding instance method";
  const checker = createBindingContext(new Map([...sources].map(([file, value]) => [file, value.sf])));
  const callSites: InlineAnalysis["callSites"] = [];
  for (const [file, src] of sources) {
    const bindings = file === wrapperFile ? new Set([target.name]) : importBindingsLocal(src.sf, file, sources, wrapperFile, target.name);
    if (!bindings.size) continue;
    const visit = (node: ts.Node): void => {
      if (isClass && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const member = members.find((m) => m.name === (node.expression as ts.PropertyAccessExpression).name.text);
        if (member) {
          const resolved = resolveCtorArgs(src.sf, node.expression.expression, bindings);
          if (resolved) callSites.push({ member, site: { file, expr: node, ctorDep: member.ctorParam ? resolved.ctorArgs[ctorParamNames.indexOf(member.ctorParam)] : undefined, args: node.arguments, ctorArgs: resolved.ctorArgs } });
        }
      } else if (!isClass && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.has(node.expression.text)) {
        const sym = checker.getSymbolAtLocation(node.expression);
        const expected = declaration && "name" in declaration && declaration.name && ts.isIdentifier(declaration.name as ts.Node) ? checker.getSymbolAtLocation(declaration.name as ts.Identifier) : undefined;
        if (bindingIdentity(sym, node.expression.text, checker) === bindingIdentity(expected, target.name, checker)) callSites.push({ member: members[0]!, site: { file, expr: node, args: node.arguments } });
      }
      node.forEachChild(visit);
    };
    visit(src.sf);
  }
  if (callSites.length !== 1) return "exactly one mechanically resolved invocation is required";
  const targetName = "name" in declaration && declaration.name && ts.isIdentifier(declaration.name as ts.Node) ? declaration.name as ts.Identifier : undefined;
  const targetIdentity = bindingIdentity(targetName ? checker.getSymbolAtLocation(targetName) : undefined, target.name, checker);
  let escaped = false;
  let constructionCount = 0;
  for (const [, source] of sources) {
    const scan = (node: ts.Node): void => {
      if (node === declaration) return;
      if (ts.isIdentifier(node) && bindingIdentity(checker.getSymbolAtLocation(node), node.text, checker) === targetIdentity) {
        const parent = node.parent;
        const importName = ts.isImportSpecifier(parent) || ts.isImportClause(parent);
        const invocation = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
        if (ts.isNewExpression(parent) && parent.expression === node) constructionCount++;
        if (!importName && !invocation && !isTypePosition(node)) escaped = true;
      }
      node.forEachChild(scan);
    };
    scan(source.sf);
  }
  if (escaped || (isClass && constructionCount !== 1)) return "wrapper identity escapes, or its construction is not single-use";
  const { site, member } = callSites[0]!;
  if (isClass && (site.ctorArgs?.length ?? 0) !== ctorParamNames.length) return "constructor arity would change argument evaluation";
  if (site.expr.questionDotToken || site.args.some(ts.isSpreadElement) || site.args.length !== member.params.length) return "call arity, spread, or optional invocation would change parameter binding";
  for (const [i, argument] of site.args.entries()) if (!stableArgument(argument, site.expr, checker)) return `argument ${i + 1} may have effects or read a mutable binding; substitution cannot preserve evaluation`;
  if (member.bodyStmts && site.file !== wrapperFile) return "multi-statement bodies are supported only within their original module";
  if (member.bodyStmts) {
    const declared = new Set<string>();
    for (const stmt of member.bodyStmts) if (ts.isVariableStatement(stmt)) for (const item of stmt.declarationList.declarations) if (ts.isIdentifier(item.name)) declared.add(item.name.text); else return "destructured local bindings cannot be spliced";
    const scope = enclosingFunction(site.expr) ?? site.expr.getSourceFile();
    let collision = false;
    const scan = (n: ts.Node): void => {
      if (n === declaration) return;
      if (ts.isIdentifier(n) && declared.has(n.text)) collision = true;
      n.forEachChild(scan);
    };
    scan(scope);
    if (collision) return "spliced local binding would collide with the caller's scope";
    const parent = site.expr.parent;
    const directReturn = ts.isReturnStatement(parent) && parent.expression === site.expr;
    const directCall = ts.isExpressionStatement(parent);
    const directAssignment = ts.isBinaryExpression(parent) && parent.right === site.expr && ts.isIdentifier(parent.left) && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isExpressionStatement(parent.parent);
    if (!directReturn && !directCall && !directAssignment) return "multi-statement calls must be direct returns or assignment values; splicing here would reorder or discard surrounding expressions";
  }
  const receiver = site.expr.expression;
  const stored = isClass && ts.isPropertyAccessExpression(receiver) && !ts.isNewExpression(receiver.expression);
  if (stored && !(ts.isPropertyAccessExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.expression.kind === ts.SyntaxKind.ThisKeyword)) return "stored local wrapper instances require a lifetime-preserving transform";
  if (stored && sources.get(site.file)!.sf.statements.filter(ts.isClassDeclaration).length !== 1) return "stored wrapper lookup is ambiguous across classes";
  const transparentDependency = (node: ts.Node, seen = new Set<string>()): boolean => {
    if (ts.isExpression(node) && stableArgument(node, node, checker)) return true;
    if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) return false;
    const symbol = checker.getSymbolAtLocation(node.expression);
    const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
    const cls = resolved?.declarations?.find(ts.isClassDeclaration);
    if (!cls || seen.has(cls.getSourceFile().fileName + cls.pos) || transparentClassReason(cls)) return false;
    seen.add(cls.getSourceFile().fileName + cls.pos);
    const ctor = cls.members.find(ts.isConstructorDeclaration);
    return (node.arguments?.length ?? 0) === (ctor?.parameters.length ?? 0) && (node.arguments ?? []).every((arg) => transparentDependency(arg, seen));
  };
  if (member.ctorParam && site.ctorDep) {
    let capturesLocal = false;
    const capture = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        const decl = checker.getSymbolAtLocation(n)?.valueDeclaration;
        if (decl && ts.isVariableDeclaration(decl) && enclosingFunction(decl)) capturesLocal = true;
      }
      n.forEachChild(capture);
    };
    capture(site.ctorDep);
    if (stored && capturesLocal) return "dependency captures a constructor local that does not exist in the method scope";
    if (stored && !transparentDependency(site.ctorDep)) return "moving dependency construction from the constructor to a call changes lifetime or side effects";
    if (!stored && ts.isNewExpression(site.ctorDep) && !transparentDependency(site.ctorDep)) return "dependency constructor is not proven transparent";
  }
  for (const [i, argument] of (site.ctorArgs ?? []).entries()) {
    if (ctorParamNames[i] !== member.ctorParam && (!ts.isExpression(argument) || !stableArgument(argument, argument, checker))) return "unused constructor argument has effects that would be removed";
  }
  // Every free name introduced by the replacement must resolve to the same binding
  // at the call site, or be the one imported callee that we transfer explicitly.
  const visible = checker.getSymbolsInScope(site.expr, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias);
  let bindingReason: string | undefined;
  const scanBindings = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !member.params.includes(node.text)) {
      const parent = node.parent;
      const property = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node);
      const localDecl = ts.isVariableDeclaration(parent) && parent.name === node;
      if (!property && !localDecl) {
        const symbol = checker.getSymbolAtLocation(node);
        const declaredInside = symbol?.declarations?.some((d) => d.getSourceFile() === declaration.getSourceFile() && d.pos >= declaration.pos && d.end <= declaration.end);
        if (!declaredInside) {
          const expected = bindingIdentity(symbol, node.text, checker);
          const found = visible.find((s) => s.name === node.text);
          const actual = bindingIdentity(found, node.text, checker);
          let importedCallee = false;
          if (ts.isCallExpression(member.forwarded) || ts.isNewExpression(member.forwarded)) {
            const callee = member.forwarded.expression;
            importedCallee = callee === node && !!symbol?.declarations?.some(ts.isImportSpecifier);
            importedCallee ||= callee === node && !!symbol?.declarations?.some(ts.isImportClause);
          }
          if (expected !== actual && !(importedCallee && !found && !isTypePosition(node))) bindingReason = `free binding ${node.text} would resolve differently in the caller`;
        }
      }
    }
    node.forEachChild(scanBindings);
  };
  if (member.bodyStmts) member.bodyStmts.forEach(scanBindings); else scanBindings(member.forwarded);
  if (bindingReason) return bindingReason;
  // Same-file inlines delete only the declaration. A re-export of the
  // module stays valid because the file itself is not removed.
  if (site.file !== wrapperFile) {
    for (const statement of entry.sf.statements) {
      if (statement === declaration || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.includes(declaration as ts.VariableDeclaration)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.isTypeOnly || (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((el) => el.isTypeOnly))) continue;
        const module = ts.isStringLiteral(statement.moduleSpecifier) ? resolveFrom(wrapperFile, statement.moduleSpecifier.text, sources) : undefined;
        const alreadyImported = module && sources.get(site.file)!.sf.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && resolveFrom(site.file, s.moduleSpecifier.text, sources) === module);
        const callee = ts.isCallExpression(member.forwarded) || ts.isNewExpression(member.forwarded) ? member.forwarded.expression : undefined;
        const calleeBound = callee && ts.isIdentifier(callee) && (clause.name?.text === callee.text || (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((el) => el.name.text === callee.text)));
        if (alreadyImported || (module && calleeBound)) continue;
        return "a value import's module effects cannot be preserved at the call site";
      }
      return "deleting the wrapper module would remove another runtime declaration or module side effect";
    }
  }
  for (const [file, source] of sources) {
    let moduleReference: string | undefined;
    const scan = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && resolveFrom(file, node.moduleSpecifier.text, sources) === wrapperFile) {
        if (!ts.isImportDeclaration(node) || !node.importClause) {
          if (site.file !== wrapperFile) moduleReference = "wrapper module has a re-export or side-effect import";
        }
        else {
          const clause = node.importClause;
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) moduleReference = "namespace imports can expose wrapper identity";
          const bindsTarget = clause.name || (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((el) => (el.propertyName ?? el.name).text === target.name));
          if (bindsTarget && file !== site.file) moduleReference = "another module still imports the wrapper declaration";
          if (file === site.file && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((el) => (el.propertyName ?? el.name).text !== target.name)) moduleReference = "mixed-name wrapper imports need a separate import rewrite";
        }
      }
      if (site.file !== wrapperFile && ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && resolveFrom(file, node.arguments[0].text, sources) === wrapperFile) moduleReference = "dynamic imports or require references would outlive the wrapper module";
      node.forEachChild(scan);
    };
    scan(source.sf);
    if (moduleReference) return moduleReference;
  }
  return { callSites };
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
  const wrapperSf = entry.sf;

  const analysis = analyseInline(target, wrapperFile, sources);
  if (typeof analysis === "string") return undefined;
  const { callSites } = analysis;
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
    splice ?? { start: site.expr.getStart(siteEntry.sf), end: site.expr.getEnd(), text: /^\s*\{/.test(resolved.text) && (ts.isExpressionStatement(site.expr.parent) || ts.isArrowFunction(site.expr.parent)) ? `(${resolved.text})` : resolved.text },
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
      const start = stmt.getStart(sf1), end = stmt.getEnd();
      const lineStart = callerText.lastIndexOf("\n", start - 1) + 1;
      const nl = callerText.indexOf("\n", end);
      const lineEnd = nl === -1 ? callerText.length : nl;
      const ownsLine = !callerText.slice(lineStart, start).trim() && !callerText.slice(end, lineEnd).trim();
      removed = ownsLine ? callerText.slice(0, lineStart) + callerText.slice(nl === -1 ? lineEnd : nl + 1) : callerText.slice(0, start) + callerText.slice(end);
      break;
    }
    // No import to remove is fine (same-file wrappers never reach
    // here — the wrapper file is a different file by construction).
    if (removed !== undefined) callerText = removed;
  }

  // The forwarded callee may need importing into the surviving caller.
  if (resolved.neededImport) {
    const { local, imported, from } = resolved.neededImport;
    const binding = imported === "default" ? local : `{ ${imported === local ? local : `${imported} as ${local}`} }`;
    callerText = `import ${binding} from ${JSON.stringify(relativeSpecifier(site.file, from))};\n` + callerText;
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
    const cleaned = eraseStoredWrapper(callerText, site.file, receiver.expression.name.text, resolved.thisDeps);
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

