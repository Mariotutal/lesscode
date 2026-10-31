import ts from "typescript";
import { parse } from "../classify/target.js";

/**
 * Unrelated-change guard (LES-21).
 *
 * Model-supplied file contents no longer exist for inline/retarget
 * (the AST codemods generate those), but any content a caller still
 * hands the applier — and any future model-supplied content — passes
 * through this guard before it is written:
 *
 * Diff the AST of the rewritten file against the original. Refuse
 * when any top-level statement outside the targeted symbol or its
 * imports changed: an edit may rewrite the targeted declaration and
 * the import block, never an unrelated statement.
 *
 * The comparison is statement-level and text-based after parsing, so
 * formatting shifts inside an allowed statement count (its text
 * changed), but an inserted/removed/altered unrelated statement is
 * always caught.
 */
export function unrelatedChangeReason(
  file: string,
  before: string,
  after: string,
  targetedSymbol: string,
  /** Statements the code-generated codemod itself changes (its call-site / importer file): also allowed to differ. */
  allowedChangedStatements: readonly string[] = [],
): string | undefined {
  let beforeSf: ts.SourceFile;
  let afterSf: ts.SourceFile;
  try {
    beforeSf = parse(file, before);
    afterSf = parse(file, after);
  } catch {
    return "unrelated-change guard: file does not parse";
  }

  const key = (stmt: ts.Statement): string => {
    if (ts.isImportDeclaration(stmt)) return `import:${ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "?"}`;
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) {
      return `decl:${stmt.name.text}`;
    }
    if (ts.isVariableStatement(stmt)) {
      return `decl:${stmt.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : d.name.getText())).join(",")}`;
    }
    if (ts.isExportDeclaration(stmt)) return `export:${stmt.getText()}`;
    return `stmt:${ts.SyntaxKind[stmt.kind]}`;
  };

  const bucket = (sf: ts.SourceFile): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const stmt of sf.statements) {
      const k = key(stmt);
      const list = out.get(k) ?? [];
      list.push(stmt.getText(sf));
      out.set(k, list);
    }
    return out;
  };

  const allowed = new Set(allowedChangedStatements);
  const isAllowed = (k: string): boolean =>
    k.startsWith("import:") || k === `decl:${targetedSymbol}` || allowed.has(k);

  const b = bucket(beforeSf);
  const a = bucket(afterSf);
  const changed: string[] = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    if (isAllowed(k)) continue;
    const beforeList = b.get(k) ?? [];
    const afterList = a.get(k) ?? [];
    if (beforeList.length !== afterList.length || beforeList.some((t, i) => t !== afterList[i])) {
      changed.push(k);
    }
  }
  if (changed.length) {
    return `unrelated statement(s) outside the targeted symbol "${targetedSymbol}" or its imports changed: ${changed.join(", ")}`;
  }
  return undefined;
}

/** Statement keys whose text differs between two versions of a file. */
export function statementDiffKeys(file: string, before: string, after: string): string[] {
  const keysOf = (text: string): Map<string, string[]> => {
    const sf = parse(file, text);
    const out = new Map<string, string[]>();
    for (const stmt of sf.statements) {
      const k = statementKey(stmt);
      const list = out.get(k) ?? [];
      list.push(stmt.getText(sf));
      out.set(k, list);
    }
    return out;
  };
  const b = keysOf(before);
  const a = keysOf(after);
  const changed: string[] = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const bl = b.get(k) ?? [];
    const al = a.get(k) ?? [];
    if (bl.length !== al.length || bl.some((t, i) => t !== al[i])) changed.push(k);
  }
  return changed;
}

export function statementKey(stmt: ts.Statement): string {
  if (ts.isImportDeclaration(stmt)) return `import:${ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "?"}`;
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) {
    return `decl:${stmt.name.text}`;
  }
  if (ts.isVariableStatement(stmt)) {
    return `decl:${stmt.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : d.name.getText())).join(",")}`;
  }
  if (ts.isExportDeclaration(stmt)) return `export:${stmt.getText()}`;
  return `stmt:${ts.SyntaxKind[stmt.kind]}`;
}
