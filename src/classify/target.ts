import ts from "typescript";
import type { Finding } from "./schema.js";

/**
 * Shared AST helpers for locating the declaration a finding cites
 * (used by the LES-20 verifier and the LES-21 codemods, which must
 * agree on which symbol a citation names).
 */

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

export interface CitedTarget {
  name: string;
  /** Enclosing class name when the target is a method. */
  className?: string;
  decl: ts.Node;
  file: string;
}

function overlaps(sf: ts.SourceFile, node: ts.Node, ranges: { start: number; end: number }[]): boolean {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return ranges.some((r) => start <= r.end && r.start <= end);
}

export function topLevelDecls(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  sf.forEachChild((n) => {
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) out.push(d);
    else out.push(n);
  });
  return out;
}

export function declName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

/** Smallest declaration in `file` overlapping a citation in that file. */
export function findTarget(sf: ts.SourceFile, file: string, finding: Finding): CitedTarget | undefined {
  const ranges = finding.citations.filter((c) => c.file === file).map((c) => ({ start: c.startLine, end: c.endLine }));
  if (!ranges.length) return undefined;
  const tops = topLevelDecls(sf).filter((n) => declName(n) !== undefined && overlaps(sf, n, ranges));
  tops.sort((a, b) => a.getText(sf).length - b.getText(sf).length);
  const top = tops[0];
  if (!top) return undefined;
  // A citation pinpointing one method of a class targets that method.
  if (ts.isClassDeclaration(top)) {
    const methods = top.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && overlaps(sf, m, ranges));
    // Only narrow when a citation starts inside the method (not the class head).
    const pinpointed = methods.filter((m) => ranges.some((r) => {
      const s = sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1;
      const classStart = sf.getLineAndCharacterOfPosition(top.getStart(sf)).line + 1;
      return r.start >= s && classStart < r.start;
    }));
    if (pinpointed.length === 1 && pinpointed[0]!.name && ts.isIdentifier(pinpointed[0]!.name)) {
      return { name: pinpointed[0]!.name.text, className: top.name?.text, decl: pinpointed[0]!, file };
    }
  }
  const name = declName(top);
  return name ? { name, decl: top, file } : undefined;
}
