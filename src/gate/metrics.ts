import ts from "typescript";

export interface FunctionMetric {
  file: string;
  name: string;
  complexity: number;
  startLine: number;
  /** SyntaxKind name of the declaration, e.g. MethodDeclaration vs FunctionDeclaration. */
  kind: string;
  /** Stable identity within a file: file + name + kind + position among same name/kind. */
  key: string;
}

export interface SourceMetrics {
  /** Non-blank, non-comment source lines, counted with the TS scanner. */
  sizeLines: number;
  functions: FunctionMetric[];
  cyclomaticSum: number;
}

/**
 * Lines containing at least one real token, counted with the TS
 * scanner. Comment tokens never count; comment-like sequences inside
 * strings/templates are string tokens, so they do count. A multi-line
 * token (block comment / template) counts only lines it puts code on:
 * block comments count nothing, templates count every line they span
 * because the literal is code on each of those lines.
 */
function variantFor(file: string): ts.LanguageVariant {
  const kind = (ts as unknown as { getScriptKindFromFileName?: (f: string) => ts.ScriptKind }).getScriptKindFromFileName?.(file);
  return kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
}

export function countCodeLines(file: string, source: string): number {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, variantFor(file), source);
  const codeLines = new Set<number>();
  let line = 0;
  let atLineStart = true;
  for (;;) {
    // Scanner line tracking: scan() advances over trivia when skipTrivia
    // is false it returns comment/trivia tokens explicitly. Track lines
    // by counting newlines in each token's text.
    const kind = scanner.scan();
    const text = scanner.getTokenText();
    const isComment = kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia;
    const isTrivia = isComment || kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia;
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (!isTrivia) {
      const spans = text.split("\n").length - 1;
      for (let i = 0; i <= spans; i++) codeLines.add(line + i);
      void atLineStart;
    }
    line += text.split("\n").length - 1;
    atLineStart = kind === ts.SyntaxKind.NewLineTrivia;
  }
  return codeLines.size;
}

/** Kept for compatibility: strips comments lexically via the scanner (strings preserved). */
export function stripComments(source: string, file = "file.ts"): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variantFor(file), source);
  let out = "";
  for (;;) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    const text = scanner.getTokenText();
    out += kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia
      ? text.replace(/[^\n]/g, " ")
      : text;
  }
  return out;
}

export function isCodeLine(line: string): boolean {
  return stripComments(line).trim().length > 0;
}

function functionName(node: ts.Node, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) {
    return node.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.getText(sf);
  }
  if (ts.isPropertyAssignment(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.getText(sf);
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent && (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))) return node.parent.name.getText(sf);
  // Anonymous function: identify by enclosing named declaration + kind,
  // e.g. `foo.<anonymous>` for a callback inside `foo` is still
  // positional via `key`; name alone deliberately stays <anonymous>.
  return "<anonymous>";
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Cyclomatic complexity of one function body: 1 + decision points, not descending into nested functions. */
export function complexityOf(node: ts.Node): number {
  let count = 1;
  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLike(n)) return;
    if (
      ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isForStatement(n) ||
      ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) ||
      ts.isDoStatement(n) || ts.isCatchClause(n)
    ) count++;
    if (ts.isCaseClause(n)) count++;
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) count++;
    n.forEachChild(visit);
  };
  visit(node);
  return count;
}

export function measureSource(file: string, source: string): SourceMetrics {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions: FunctionMetric[] = [];
  const seen = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const name = functionName(node, sf);
      const kind = ts.SyntaxKind[node.kind];
      const containers: string[] = [];
      for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isModuleDeclaration(parent)) && parent.name) containers.unshift(parent.name.getText(sf));
        else if (isFunctionLike(parent)) containers.unshift(functionName(parent, sf));
      }
      const identity = `${containers.join(".")}\0${name}\0${kind}`;
      const ordinal = seen.get(identity) ?? 0;
      seen.set(identity, ordinal + 1);
      functions.push({
        file,
        name,
        complexity: complexityOf(node),
        startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        kind,
        // Position among same name+kind declarations in the file is the
        // tie-break (declaration order is stable for a surviving function).
        key: `${file}\0${identity}\0${ordinal}`,
      });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { sizeLines: countCodeLines(file, source), functions, cyclomaticSum: functions.reduce((a, f) => a + f.complexity, 0) };
}
