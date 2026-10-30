import ts from "typescript";

export interface FunctionMetric {
  file: string;
  name: string;
  complexity: number;
  startLine: number;
}

export interface SourceMetrics {
  /** Non-blank, non-comment source lines (git line count minus blanks/comments). */
  sizeLines: number;
  functions: FunctionMetric[];
  cyclomaticSum: number;
}

/** Strip // and block comments without touching string contents (approx: strings have no comment-like seq in fixtures). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export function isCodeLine(line: string): boolean {
  return stripComments(line).trim().length > 0;
}

function functionName(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sf) ?? "<anonymous>";
  }
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.getText(sf);
  }
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
  const lines = source.split("\n").filter(isCodeLine).length;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions: FunctionMetric[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      functions.push({
        file,
        name: functionName(node, sf),
        complexity: complexityOf(node),
        startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { sizeLines: lines, functions, cyclomaticSum: functions.reduce((a, f) => a + f.complexity, 0) };
}
