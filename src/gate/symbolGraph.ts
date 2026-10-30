import ts from "typescript";

export interface FileSymbols {
  file: string;
  /** name -> signature string (declaration text, whitespace-normalised) */
  exports: Map<string, string>;
  /** exported names referenced from other files in the set */
  referencedByOthers: Set<string>;
  /** names imported by this file, by resolved target name */
  imports: Set<string>;
}

function exportedDeclarations(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string, node: ts.Node) => out.set(name, node.getText(sf).replace(/\s+/g, " ").trim());
  const visit = (node: ts.Node): void => {
    const mods = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
    const isExported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isExported && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      add(node.name.text, node);
    } else if (isExported && ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d);
    } else if (isExported && ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) add(el.name.text, el);
    } else if (isDefault) {
      add("default", node);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Build a lightweight symbol graph: exports per file + cross-file references to exported names. */
export function buildSymbolGraph(files: Map<string, string>): Map<string, FileSymbols> {
  const parsed = new Map<string, ts.SourceFile>();
  for (const [file, src] of files) parsed.set(file, ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true));

  const graph = new Map<string, FileSymbols>();
  for (const [file, sf] of parsed) {
    graph.set(file, { file, exports: exportedDeclarations(sf), referencedByOthers: new Set(), imports: new Set() });
  }

  // symbol name -> defining files
  const byName = new Map<string, string[]>();
  for (const [file, syms] of graph) for (const name of syms.exports.keys()) byName.set(name, [...(byName.get(name) ?? []), file]);

  for (const [file, sf] of parsed) {
    const imported = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const clause = node.importClause;
        if (clause.name) imported.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) imported.add(clause.namedBindings.name.text);
          else for (const el of clause.namedBindings.elements) imported.add(el.name.text);
        }
      }
      if (ts.isIdentifier(node)) {
        for (const defFile of byName.get(node.text) ?? []) {
          if (defFile !== file && imported.has(node.text)) graph.get(defFile)!.referencedByOthers.add(node.text);
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
    graph.get(file)!.imports = imported;
  }
  return graph;
}
