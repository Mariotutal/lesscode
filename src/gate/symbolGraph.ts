import ts from "typescript";

export interface FileSymbols {
  file: string;
  /** name -> signature string (declaration text, whitespace-normalised) */
  exports: Map<string, string>;
  /** exported names referenced from other files in the set */
  referencedByOthers: Set<string>;
  /** names imported by this file, by resolved target name */
  imports: Set<string>;
  /** repo-relative files this file imports from (resolved, in-set only) */
  importedFiles: Set<string>;
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

/** Virtual root under which the in-memory file set is presented to the compiler. */
const VIRTUAL_ROOT = "/__lesscode__";

function toFileName(key: string): string {
  const normalised = key.replace(/\\/g, "/");
  return normalised.startsWith("/") ? normalised : `${VIRTUAL_ROOT}/${normalised}`;
}

/**
 * Build a symbol graph whose cross-file references are resolved by the
 * TypeScript checker, not by identifier name.
 *
 * The file set is served to `ts.createProgram` through an in-memory compiler
 * host, so `./a.js` in `import { formatMoney } from "./a.js"` resolves (via
 * the checker's `getSymbolAtLocation` / `getAliasedSymbol`) to the symbol's
 * actual declaring file. If `a.ts` and `b.ts` both export `formatMoney`,
 * only the file the specifier resolves to is credited in
 * `referencedByOthers`. Deterministic: no model, no filesystem reads of the
 * file set (lib files, if any, are never consulted: `noLib` is set).
 */
export function buildSymbolGraph(files: Map<string, string>): Map<string, FileSymbols> {
  const fileNameByKey = new Map<string, string>();
  const keyByFileName = new Map<string, string>();
  for (const key of files.keys()) {
    const fileName = toFileName(key);
    fileNameByKey.set(key, fileName);
    keyByFileName.set(ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(), key);
  }
  const keyFor = (fileName: string): string | undefined =>
    keyByFileName.get(ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase());

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // One program reads both languages (spec): allowJs puts .js files
    // in the program so an import resolving to a .js file is credited.
    // checkJs stays OFF here — the graph must not fail a .js file for
    // missing types; the gate's tsc step uses the repository's own
    // tsconfig and therefore its own checkJs setting.
    allowJs: true,
    checkJs: false,
    noLib: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.getCurrentDirectory = () => VIRTUAL_ROOT;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = keyFor(fileName);
    if (key !== undefined) return ts.createSourceFile(fileName, files.get(key)!, languageVersion, true);
    return baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => keyFor(fileName) !== undefined || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => {
    const key = keyFor(fileName);
    return key !== undefined ? files.get(key) : ts.sys.readFile(fileName);
  };
  // The default host's module resolution closes over its own fileExists, so
  // overriding fileExists alone never sees the in-memory set. Resolve
  // relative specifiers onto the set explicitly (`.js` -> `.ts`, extensionless,
  // `/index`); bare specifiers stay unresolved (external: no credit).
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((lit) => {
      const spec = lit.text;
      if (!spec.startsWith(".")) return { resolvedModule: undefined };
      const dir = ts.sys.useCaseSensitiveFileNames ? containingFile.slice(0, containingFile.lastIndexOf("/")) : containingFile.slice(0, containingFile.lastIndexOf("/")).toLowerCase();
      // Resolve `.`/`..` segments against the containing file's directory.
      const parts: string[] = [];
      for (const seg of `${dir}/${spec}`.split("/")) {
        if (seg === ".." ) parts.pop();
        else if (seg !== "." && seg !== "") parts.push(seg);
      }
      const joined = `/${parts.join("/")}`;
      const stems = [joined, joined.replace(/\.(m|c)?js$/, ""), joined.replace(/\.json$/, "")];
      const exts = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mts"];
      for (const stem of stems) {
        for (const cand of [stem, ...exts.map((e) => stem + e), ...exts.map((e) => `${stem}/index${e}`)]) {
          if (keyFor(cand) !== undefined) {
            return { resolvedModule: { resolvedFileName: cand, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
          }
        }
      }
      return { resolvedModule: undefined };
    });

  const program = ts.createProgram([...fileNameByKey.values()], options, host);
  const checker = program.getTypeChecker();

  const graph = new Map<string, FileSymbols>();
  const sourceByKey = new Map<string, ts.SourceFile>();
  for (const sf of program.getSourceFiles()) {
    const key = keyFor(sf.fileName);
    if (key === undefined || sourceByKey.has(key)) continue;
    sourceByKey.set(key, sf);
    graph.set(key, { file: key, exports: exportedDeclarations(sf), referencedByOthers: new Set(), imports: new Set(), importedFiles: new Set() });
  }
  // Files the program somehow skipped must still appear in the graph.
  for (const [key, src] of files) {
    if (graph.has(key)) continue;
    const sf = ts.createSourceFile(fileNameByKey.get(key)!, src, ts.ScriptTarget.Latest, true);
    sourceByKey.set(key, sf);
    graph.set(key, { file: key, exports: exportedDeclarations(sf), referencedByOthers: new Set(), imports: new Set(), importedFiles: new Set() });
  }

  /** Credit the file that actually declares the symbol at `id`, if it is in the set and not `fromFile`. */
  const credit = (fromFile: string, id: ts.Identifier): void => {
    let sym: ts.Symbol | undefined;
    try {
      sym = checker.getSymbolAtLocation(id);
      if (sym && (sym.flags & ts.SymbolFlags.Alias)) sym = checker.getAliasedSymbol(sym);
    } catch {
      return; // unresolvable alias (e.g. missing module): no credit, by design
    }
    if (!sym?.declarations) return;
    for (const decl of sym.declarations) {
      const defFile = keyFor(decl.getSourceFile().fileName);
      if (defFile !== undefined && defFile !== fromFile && graph.get(defFile)?.exports.has(sym.name)) {
        graph.get(defFile)!.referencedByOthers.add(sym.name);
      }
    }
  };

  for (const [file, sf] of sourceByKey) {
    const imported = new Set<string>();
    const importedFiles = graph.get(file)!.importedFiles;
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // Record the checker-resolved target file (same resolution
        // that credits referencedByOthers), if it is in the set.
        const moduleSym = checker.getSymbolAtLocation(node.moduleSpecifier);
        for (const decl of moduleSym?.declarations ?? []) {
          const defFile = keyFor(decl.getSourceFile().fileName);
          if (defFile !== undefined && defFile !== file) importedFiles.add(defFile);
        }
        // Named bindings live under importClause.namedBindings (import) or
        // the ExportDeclaration's own exportClause (re-export).
        const bindings: ts.Node | undefined = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
        if (!bindings) {
          // `export * from "./a.js"`: credit every export of the resolved module.
          const moduleSym = checker.getSymbolAtLocation(node.moduleSpecifier);
          if (moduleSym) {
            for (const exp of checker.getExportsOfModule(moduleSym)) {
              for (const decl of exp.declarations ?? []) {
                const defFile = keyFor(decl.getSourceFile().fileName);
                if (defFile !== undefined && defFile !== file && graph.get(defFile)?.exports.has(exp.name)) {
                  graph.get(defFile)!.referencedByOthers.add(exp.name);
                }
              }
            }
          }
        } else if (ts.isImportClause(bindings) && bindings.namedBindings && ts.isNamespaceImport(bindings.namedBindings)) {
          // Member references (ns.foo) are resolved at the property access below.
          imported.add(bindings.namedBindings.name.text);
        } else {
          if (ts.isImportClause(bindings) && bindings.name) { imported.add(bindings.name.text); credit(file, bindings.name); }
          const named: ts.Node | undefined = ts.isImportClause(bindings) ? bindings.namedBindings : bindings;
          const elements = named && (ts.isNamedImports(named) || ts.isNamedExports(named)) ? named.elements : [];
          for (const el of elements) {
            if (ts.isImportDeclaration(node)) imported.add(el.name.text);
            // `el.name` may be a StringLiteral for `import { "x" as y }`.
            if (ts.isIdentifier(el.name)) credit(file, el.name);
          }
        }
      }
      // Namespace member access and any other checker-resolvable reference.
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) credit(file, node.name);
      node.forEachChild(visit);
    };
    visit(sf);
    graph.get(file)!.imports = imported;
  }
  return graph;
}

/**
 * The one importers-of-a-file computation (LES-29): every file in
 * the graph whose imports the checker resolved onto `target`.
 * Callers that previously regex-scanned import specifiers (planner
 * allowed-set, gate test-coverage) ask this instead.
 */
export function importersOf(graph: Map<string, FileSymbols>, target: string): string[] {
  return [...graph.values()].filter((s) => s.file !== target && s.importedFiles.has(target)).map((s) => s.file);
}

/** Files `file` transitively imports within the graph (cycle-safe; excludes `file` itself). */
export function transitiveImports(graph: Map<string, FileSymbols>, file: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(graph.get(file)?.importedFiles ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === file || out.has(cur)) continue;
    out.add(cur);
    stack.push(...(graph.get(cur)?.importedFiles ?? []));
  }
  return out;
}
