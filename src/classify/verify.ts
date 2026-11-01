import ts from "typescript";
import { buildSymbolGraph } from "../gate/symbolGraph.js";
import { isSourceFile, listClassifiableFiles, readCheckoutSources } from "./checkout.js";
import { isSealedPath, normaliseRepoPath } from "./evidence.js";
import type { Finding } from "./schema.js";
import { declName, findTarget, parse, topLevelDecls, type CitedTarget } from "./target.js";

/**
 * Code verification of model findings (LES-20): between classify and
 * plan. Spark reports candidates; code decides truth. No model call.
 *
 * - single-use-abstraction: the cited symbol must have exactly one
 *   call site outside its definition (counted from the TypeScript AST
 *   across the checkout, cross-checked against the checker-resolved
 *   symbol graph's `referencedByOthers`), and its body must be a pure
 *   forward — no transform, validation, unwrap, or branching.
 * - duplicate-helper: the cited duplicate's body must be equivalent
 *   to the existing helper's body under a rename-insensitive
 *   normalised AST comparison, or callers cannot be retargeted.
 *
 * A finding that fails is dropped with a reason, the same way an
 * invented citation is dropped by the evidence filter.
 */
export interface VerificationDrop {
  finding: Finding;
  reason: string;
}

export interface VerificationResult {
  kept: Finding[];
  dropped: VerificationDrop[];
}

type Target = CitedTarget;

/** Resolve a relative import specifier onto a file in the set. */
function resolveSpec(fromFile: string, spec: string, files: Set<string>): string | undefined {
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
}

/** local binding name -> {file, original name} for relative imports in one file. */
function importBindings(sf: ts.SourceFile, fromFile: string, files: Set<string>): Map<string, { file: string; name: string }> {
  const out = new Map<string, { file: string; name: string }>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
      const target = resolveSpec(fromFile, node.moduleSpecifier.text, files);
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

/** Count real call sites of the target outside its own definition. */
function countCallSites(sources: Map<string, ts.SourceFile>, target: Target): number {
  const files = new Set(sources.keys());
  let count = 0;
  for (const [file, sf] of sources) {
    const bindings = importBindings(sf, file, files);
    const isTargetBinding = (id: ts.Identifier): boolean => {
      if (target.className) return false;
      if (file === target.file && id.text === target.name && !bindings.has(id.text)) return true;
      const b = bindings.get(id.text);
      return b?.file === target.file && b.name === target.name;
    };
    const visit = (node: ts.Node): void => {
      if (node === target.decl) return; // never count inside the definition
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression) {
        const expr = node.expression;
        if (ts.isIdentifier(expr) && isTargetBinding(expr)) count++;
        else if (target.className && ts.isPropertyAccessExpression(expr) && expr.name.text === target.name) count++;
        else if (!target.className && ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
          // Namespace import: ns.name(...)
          const b = bindings.get(expr.expression.text);
          if (b?.file === target.file && expr.name.text === target.name) count++;
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return count;
}

const FORBIDDEN = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BinaryExpression, // transform / validation operators (incl. &&, ||, +, ??)
  ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ObjectLiteralExpression, ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.NonNullExpression, ts.SyntaxKind.AsExpression, ts.SyntaxKind.TypeAssertionExpression,
]);

/** Why `node` (a function/method/arrow body) is not a pure forward, or undefined when it is. */
function impureReason(body: ts.Node, insideClass = false): string | undefined {
  let expr: ts.Node;
  if (ts.isBlock(body)) {
    const only = body.statements[0];
    if (body.statements.length === 1 && only && ts.isReturnStatement(only) && only.expression) {
      expr = only.expression;
    } else if (
      // Multi-statement forward: local bindings that are pure calls,
      // then a return over locals/params (e.g. lineTotal binds `rate`
      // from applyPromotions(...) and returns arithmetic on it). The
      // AST codemod splices these statements verbatim, so no branch
      // or transform is hidden — branching in any statement still
      // fails the FORBIDDEN scan below.
      body.statements.length > 1 &&
      body.statements.slice(0, -1).every((s) => ts.isVariableStatement(s)) &&
      ts.isReturnStatement(body.statements.at(-1)!) &&
      (body.statements.at(-1) as ts.ReturnStatement).expression
    ) {
      let bad: string | undefined;
      for (const s of body.statements) {
        const scan = (n: ts.Node): void => {
          if (bad) return;
          if (n !== s && FORBIDDEN.has(n.kind) && n.kind !== ts.SyntaxKind.BinaryExpression) { bad = `body contains ${ts.SyntaxKind[n.kind]}`; return; }
          n.forEachChild(scan);
        };
        scan(s);
      }
      return bad;
    } else {
      return "body is not a single return statement";
    }
  } else {
    expr = body;
  }
  while (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isCallExpression(expr) && !ts.isNewExpression(expr)) {
    return "body does not forward to a single call";
  }
  // Unwrap: calling/accessing the *result* of a call, e.g. inner.get().data
  // (the callee chain must bottom out at an identifier / member / this).
  let callee: ts.Node = expr.expression;
  while (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee) && callee.kind !== ts.SyntaxKind.ThisKeyword && !ts.isPropertyAccessExpression(callee)) {
    return "body unwraps or chains off a call result";
  }
  if (ts.isCallExpression(expr.expression) || ts.isNewExpression(expr.expression)) return "body unwraps a call result";
  let bad: string | undefined;
  let nestedCalls = 0;
  const visit = (node: ts.Node, isRoot: boolean): void => {
    if (bad) return;
    if (!isRoot) {
      if (FORBIDDEN.has(node.kind)) { bad = `body contains ${ts.SyntaxKind[node.kind]} (transform, validation, unwrap, or branching)`; return; }
      // Class-building constructor calls inside the forwarded call are
      // how a wrapper forwards its own collaborators (e.g.
      // `new Service(new Repo(client))`), not transforms of the value.
      if (insideClass && ts.isNewExpression(node)) { nestedCalls++; if (nestedCalls > 0) { node.forEachChild((c) => visit(c, false)); return; } }
      // A nested call inside the forwarded call's arguments transforms
      // or validates the value on the way through.
      if (ts.isCallExpression(node)) { bad = "body calls another function inside the forwarded arguments (transform or validation)"; return; }
      if (ts.isPropertyAccessExpression(node) && (ts.isCallExpression(node.expression) || ts.isAwaitExpression(node.expression))) { bad = "body unwraps a call result"; return; }
    }
    node.forEachChild((c) => visit(c, false));
  };
  visit(expr, true);
  return bad;
}

function pureForwardReason(target: Target): string | undefined {
  const d = target.decl;
  if (ts.isClassDeclaration(d)) {
    const methods = d.members.filter((m) => !ts.isConstructorDeclaration(m));
    if (!methods.length) return "class has no forwarding method";
    for (const m of methods) {
      if (!ts.isMethodDeclaration(m) && !ts.isGetAccessorDeclaration(m)) return "class has non-method members";
      if (!m.body) return "class method has no body";
      const r = impureReason(m.body, true);
      if (r) return r;
    }
    return undefined;
  }
  const body = ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) ? d.body
    : ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer.body
    : undefined;
  if (!body) return "cited declaration has no function body to verify as a pure forward";
  return impureReason(body);
}

function declBody(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.body;
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.initializer.body;
  if (ts.isClassDeclaration(node)) return node;
  return undefined;
}

/** A checker over the supplied snapshot only. No repository code or filesystem is executed. */
export function createBindingContext(sources: ReadonlyMap<string, ts.SourceFile>): ts.TypeChecker {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, noLib: true, noEmit: true, types: [] };
  const key = (file: string): string => file.replace(/^\//, "");
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => "/";
  host.getSourceFile = (file) => sources.get(key(file));
  host.fileExists = (file) => sources.has(key(file));
  host.readFile = (file) => sources.get(key(file))?.text;
  host.directoryExists = () => true;
  host.getDirectories = () => [];
  host.resolveModuleNameLiterals = (literals, from) => literals.map((literal) => {
    const file = literal.text.startsWith(".") ? resolveSpec(key(from), literal.text, new Set(sources.keys())) : undefined;
    return { resolvedModule: file ? { resolvedFileName: `/${file}`, extension: file.endsWith(".js") ? ts.Extension.Js : ts.Extension.Ts } : undefined };
  });
  return ts.createProgram([...sources.keys()], options, host).getTypeChecker();
}

/** Stable identity of a free binding; two same-named module locals are deliberately different. */
export function bindingIdentity(symbol: ts.Symbol | undefined, name: string, checker: ts.TypeChecker): string {
  if (!symbol) return `global:${name}`;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased.declarations?.length) symbol = aliased;
    else {
      const declaration = symbol.declarations?.[0];
      let parent: ts.Node | undefined = declaration;
      while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
      if (parent && ts.isStringLiteral(parent.moduleSpecifier)) {
        const imported = declaration && ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : declaration && ts.isNamespaceImport(declaration) ? "*" : "default";
        // Resolution can differ between workspace packages even for the same bare specifier.
        const spec = parent.moduleSpecifier.text;
        return `unresolved-import:${parent.getSourceFile().fileName}:${spec}:${imported}`;
      }
    }
  }
  return (symbol.declarations ?? []).map((d) => `${d.getSourceFile().fileName}:${d.pos}:${d.kind}`).join("|") || `global:${name}`;
}

function callable(node: ts.Node): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.initializer;
  return undefined;
}

/**
 * Parameters are numbered by declaration position, locals by declaration order,
 * and free bindings by their actual declaration. Comparing only bodies loses
 * defaults, async/generator modifiers and the relationship to parameter order.
 */
export function normalisedAst(node: ts.Node, checker?: ts.TypeChecker): string {
  const root = ts.isBlock(node) && node.parent && callable(node.parent) ? callable(node.parent)! : node;
  const context = checker ?? createBindingContext(new Map([[root.getSourceFile().fileName, root.getSourceFile()]]));
  const locals = new Map<ts.Symbol, string>();
  let nextLocal = 0;
  const bind = (name: ts.BindingName, prefix: string): void => {
    if (ts.isIdentifier(name)) {
      const symbol = context.getSymbolAtLocation(name);
      if (symbol) locals.set(symbol, prefix);
    } else name.elements.forEach((element, i) => { if (ts.isBindingElement(element)) bind(element.name, `${prefix}.${i}`); });
  };
  const fn = callable(root);
  fn?.parameters.forEach((p, i) => bind(p.name, `parameter:${i}`));
  const collect = (n: ts.Node): void => {
    if (n !== root && ts.isFunctionLike(n)) return;
    if (ts.isVariableDeclaration(n)) bind(n.name, `local:${nextLocal++}`);
    n.forEachChild(collect);
  };
  collect(root);
  const parts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const propertyName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === n) || ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isBindingElement(parent)) && parent.name === n && !ts.isBindingElement(parent)) || (ts.isBindingElement(parent) && parent.propertyName === n));
      if (propertyName) parts.push(`property:${n.text}`);
      else if (parent === root && "name" in root && root.name === n) parts.push("declaration");
      else {
        const symbol = context.getSymbolAtLocation(n);
        const local = symbol && locals.get(symbol);
        // Object binding shorthand names are public property keys as well as locals.
        if (parent && ((ts.isShorthandPropertyAssignment(parent)) || (ts.isBindingElement(parent) && !parent.propertyName && ts.isObjectBindingPattern(parent.parent)))) parts.push(`property:${n.text}`);
        parts.push(local ?? bindingIdentity(symbol, n.text, context));
      }
      return;
    }
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isBigIntLiteral(n) || ts.isRegularExpressionLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      parts.push(`${n.kind}:${JSON.stringify(n.text)}`);
      return;
    }
    parts.push(ts.SyntaxKind[n.kind]);
    if (ts.isVariableDeclarationList(n)) parts.push(`flags:${n.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)}`);
    n.forEachChild(visit);
  };
  visit(root);
  return parts.join(" ");
}

/** Refuse duplicate retargets whose full callable contract cannot be matched. */
export function equivalentHelperReason(duplicate: ts.Node, existing: ts.Node, sources: ReadonlyMap<string, ts.SourceFile>): string | undefined {
  const a = callable(duplicate), b = callable(existing);
  if (!a?.body || !b?.body) return "only concrete functions and function-valued declarations are supported";
  let unsupported: string | undefined;
  const inspect = (node: ts.Node, root: ts.Node): void => {
    if (node !== root && (ts.isFunctionLike(node) || ts.isClassLike(node))) { unsupported = "nested functions or classes require a separate equivalence proof"; return; }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node) || (ts.isIdentifier(node) && (node.text === "arguments" || node.text === "eval"))) unsupported = "context-dependent this, arguments, super, new.target or eval is unsupported";
    node.forEachChild((child) => inspect(child, root));
  };
  inspect(a, a); inspect(b, b);
  if (unsupported) return unsupported;
  const checker = createBindingContext(sources);
  return normalisedAst(a, checker) === normalisedAst(b, checker) ? undefined : "callable signatures, parameter bindings, defaults, modifiers, or external bindings differ";
}

function findNamedDecl(sf: ts.SourceFile, name: string): ts.Node | undefined {
  return topLevelDecls(sf).find((n) => declName(n) === name);
}

export function verifyFindings(checkoutDir: string, findings: readonly Finding[]): VerificationResult {
  const relevant = findings.filter((f) => f.category === "single-use-abstraction" || f.category === "duplicate-helper");
  if (!relevant.length) return { kept: [...findings], dropped: [] };

  const sources = new Map<string, ts.SourceFile>();
  const texts = new Map<string, string>();
  for (const s of readCheckoutSources(checkoutDir)) {
    if (!isSourceFile(s.file) || isSealedPath(s.file)) continue;
    sources.set(s.file, parse(s.file, s.text));
    texts.set(s.file, s.text);
  }
  // Checker-resolved cross-file references (LES-11 symbol graph).
  const graph = buildSymbolGraph(texts);

  const dropped: VerificationDrop[] = [];
  const droppedSet = new Set<Finding>();
  const drop = (finding: Finding, reason: string): void => {
    dropped.push({ finding, reason });
    droppedSet.add(finding);
  };

  for (const finding of relevant) {
    const file = normaliseRepoPath(checkoutDir, finding.file);
    const sf = file ? sources.get(file) : undefined;
    if (!file || !sf) { drop(finding, `verification: cited file ${finding.file} is not a readable source file`); continue; }
    const target = findTarget(sf, file, finding);
    if (!target) { drop(finding, `verification: no declaration in ${file} overlaps the citations`); continue; }

    if (finding.category === "single-use-abstraction") {
      const callSites = countCallSites(sources, target);
      // Cross-check with the checker: an exported symbol the checker
      // never sees referenced from another file, with no counted call
      // site either, is not used at all — also not single-use.
      const graphReferenced = graph.get(file)?.referencedByOthers.has(target.className ?? target.name) ?? false;
      if (callSites !== 1) {
        drop(finding, `verification: ${target.name} has ${callSites} call site(s) outside its definition, not exactly one${graphReferenced ? "" : " (checker symbol graph also reports no cross-file reference)"}`);
        continue;
      }
      const impure = pureForwardReason(target);
      if (impure) { drop(finding, `verification: ${target.name} is not a pure forward — ${impure}`); continue; }
    } else {
      // duplicate-helper
      const helperFile = finding.existingHelperFile ? normaliseRepoPath(checkoutDir, finding.existingHelperFile) : undefined;
      const helperSf = helperFile ? sources.get(helperFile) : undefined;
      if (!helperFile || !helperSf || isSealedPath(helperFile)) { drop(finding, "verification: duplicate-helper names no readable existing helper file"); continue; }
      if (helperFile === file) { drop(finding, "verification: existing helper is the duplicate file itself"); continue; }
      const helper = findNamedDecl(helperSf, target.name);
      const dupBody = declBody(target.decl);
      const helperBody = helper ? declBody(helper) : undefined;
      if (!helper || !dupBody || !helperBody) { drop(finding, `verification: no helper named ${target.name} with a body in ${helperFile}`); continue; }
      const mismatch = equivalentHelperReason(target.decl, helper, sources);
      if (mismatch) {
        drop(finding, `verification: ${target.name} in ${file} is not equivalent to the existing helper in ${helperFile}: ${mismatch}; refusing to retarget`);
        continue;
      }
    }
  }
  return { kept: findings.filter((f) => !droppedSet.has(f)), dropped };
}

/** Convenience for callers that only need the surviving findings. */
export function verifyOrDrop(checkoutDir: string, findings: readonly Finding[]): Finding[] {
  return verifyFindings(checkoutDir, findings).kept;
}

export { listClassifiableFiles };
