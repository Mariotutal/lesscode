import ts from 'typescript';

type Primitive = string | number | boolean | null | undefined;
export type TraceResult = { assertion: string } | undefined;
class Unsupported extends Error {}
class Thrown { constructor(readonly name: string) {} }
const standardNames = new Set(['Number', 'Math', 'isFinite', 'parseFloat', 'RangeError', 'TypeError', 'Error', 'ReferenceError']);
const ambientNames = new Set(['arguments', 'globalThis', 'global', 'console', 'process', 'Buffer', 'module', 'exports', 'require', '__dirname', '__filename', 'Object', 'Array', 'String', 'Boolean', 'Symbol', 'BigInt', 'Date', 'JSON', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'fetch', 'Request', 'Response', 'Headers', 'AbortController', 'AbortSignal', 'WebAssembly', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'eval', 'Function', 'parseInt']);
const stringify = (value: Primitive): string => value === undefined ? 'undefined' : typeof value === 'number' && Object.is(value, -0) ? '-0' : typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
export const traceInputs: Primitive[] = [undefined, null, false, -1, 0, 1, '', '1'];
export const describeInput = stringify;

/** A bounded AST interpreter over primitives. No repository code is evaluated by JS. */
export function tracePrimitive(fn: ts.FunctionDeclaration, input: Primitive, moduleBindings: ReadonlySet<string>): TraceResult {
  if (!fn.body || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0]!.name) || fn.parameters[0]!.initializer || fn.parameters[0]!.dotDotDotToken || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken) return;
  // Declarations introduce hoisting/TDZ and closures; this interpreter does not model them.
  let unsupported = false;
  let scanned = 0;
  const scan = (node: ts.Node, depth = 0) => {
    if (++scanned > 2000 || depth > 32) { unsupported = true; return; }
    if (ts.isVariableDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) unsupported = true;
    ts.forEachChild(node, (child) => scan(child, depth + 1));
  };
  scan(fn.body);
  if (unsupported || fn.getText().length > 16_000) return;
  const parameter = fn.parameters[0]!.name.text;
  let steps = 0;
  const step = () => { if (++steps > 200) throw new Unsupported(); };
  const missing = (name: string) => name !== parameter && !moduleBindings.has(name) && !standardNames.has(name) && !ambientNames.has(name) && !['undefined', 'NaN', 'Infinity'].includes(name);
  const read = (name: string): Primitive => {
    if (name === parameter) return input;
    if (moduleBindings.has(name)) throw new Unsupported();
    if (name === 'undefined') return undefined;
    if (name === 'NaN') return NaN;
    if (name === 'Infinity') return Infinity;
    if (missing(name)) throw new Thrown('ReferenceError');
    throw new Unsupported();
  };
  const expression = (node: ts.Expression): Primitive => {
    step();
    if (ts.isParenthesizedExpression(node)) return expression(node.expression);
    if (ts.isIdentifier(node)) return read(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isTypeOfExpression(node)) {
      let operand: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
      if (ts.isIdentifier(operand) && missing(operand.text)) return 'undefined';
      return typeof expression(node.expression);
    }
    if (ts.isPrefixUnaryExpression(node)) {
      if (![ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) throw new Unsupported();
      const value = expression(node.operand);
      if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
      if (node.operator === ts.SyntaxKind.PlusToken) return Number(value);
      if (node.operator === ts.SyntaxKind.MinusToken) return -Number(value);
      throw new Unsupported();
    }
    if (ts.isConditionalExpression(node)) return expression(node.condition) ? expression(node.whenTrue) : expression(node.whenFalse);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (![ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(op)) throw new Unsupported();
      const left = expression(node.left);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return left ? expression(node.right) : left;
      if (op === ts.SyntaxKind.BarBarToken) return left ? left : expression(node.right);
      if (op === ts.SyntaxKind.QuestionQuestionToken) return left == null ? expression(node.right) : left;
      const right = expression(node.right);
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
      if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
      // Numeric operands only: do not approximate relational string/coercion semantics.
      if (typeof left !== 'number' || typeof right !== 'number') throw new Unsupported();
      if (op === ts.SyntaxKind.LessThanToken) return left < right;
      if (op === ts.SyntaxKind.LessThanEqualsToken) return left <= right;
      if (op === ts.SyntaxKind.GreaterThanToken) return left > right;
      if (op === ts.SyntaxKind.GreaterThanEqualsToken) return left >= right;
      if (op === ts.SyntaxKind.MinusToken) return left - right;
      if (op === ts.SyntaxKind.PlusToken) return left + right;
      if (op === ts.SyntaxKind.AsteriskToken) return left * right;
      if (op === ts.SyntaxKind.SlashToken) return left / right;
      throw new Unsupported();
    }
    // No arbitrary calls, property getters, imports, constructors or user functions.
    if (ts.isCallExpression(node) && node.arguments.length === 1 && !node.questionDotToken) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && ['isFinite', 'parseFloat'].includes(callee.text) && !moduleBindings.has(callee.text) && callee.text !== parameter) {
        const value = expression(node.arguments[0]!);
        return callee.text === 'isFinite' ? Number.isFinite(Number(value)) : parseFloat(String(value));
      }
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && !moduleBindings.has(callee.expression.text) && callee.expression.text !== parameter) {
        const value = expression(node.arguments[0]!);
        if (callee.expression.text === 'Number' && callee.name.text === 'isFinite') return typeof value === 'number' && Number.isFinite(value);
        if (callee.expression.text === 'Math' && callee.name.text === 'sign' && typeof value === 'number') return Math.sign(value);
      }
    }
    throw new Unsupported();
  };
  const statement = (node: ts.Statement): { value: Primitive } | undefined => {
    step();
    if (ts.isBlock(node)) { for (const child of node.statements) { const result = statement(child); if (result) return result; } return; }
    if (ts.isReturnStatement(node)) return { value: node.expression ? expression(node.expression) : undefined };
    if (ts.isIfStatement(node)) return expression(node.expression) ? statement(node.thenStatement) : node.elseStatement ? statement(node.elseStatement) : undefined;
    if (ts.isEmptyStatement(node) || ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)) return;
    if (ts.isThrowStatement(node) && ts.isNewExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const name = node.expression.expression.text;
      if (!['Error', 'RangeError', 'TypeError', 'ReferenceError'].includes(name) || moduleBindings.has(name) || name === parameter) throw new Unsupported();
      for (const arg of node.expression.arguments ?? []) expression(arg);
      throw new Thrown(name);
    }
    throw new Unsupported();
  };
  try { return { assertion: `returns:${stringify(statement(fn.body)?.value)}` }; }
  catch (error) { return error instanceof Thrown ? { assertion: `throws:${error.name}` } : undefined; }
}
