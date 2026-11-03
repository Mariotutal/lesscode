import ts from 'typescript';
import { createHash } from 'node:crypto';
import { isTestFile, type CheckoutSource } from '../classify/checkout.js';
import { isSealedPath } from '../classify/evidence.js';
import type { ReviewFact, Scalar } from './claims.js';
import { describeInput, traceInputs, tracePrimitive } from './primitiveTrace.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bindingNames = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((e) => ts.isBindingElement(e) ? bindingNames(e.name) : []);
function moduleBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if ('name' in node && node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
      return;
    }
    if (ts.isVariableDeclaration(node)) for (const name of bindingNames(node.name)) names.add(name);
    if (ts.isImportEqualsDeclaration(node)) names.add(node.name.text);
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) names.add(node.name.text);
    if (ts.isImportDeclaration(node) && node.importClause) {
      if (node.importClause.name) names.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) names.add(item.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}
function literal(node: ts.Expression): { value: Scalar } | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text };
  if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand) && node.operator === ts.SyntaxKind.MinusToken) return { value: -Number(node.operand.text) };
  return;
}
/** Produces facts only from supplied head source. No files or globals are opened. */
export function collectReviewFacts(sources: readonly CheckoutSource[]): ReviewFact[] {
  const facts: ReviewFact[] = [];
  for (const source of sources) {
    if (facts.length >= 64) break;
    if (isSealedPath(source.file) || source.text.length > 128_000) continue;
    const sf = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true);
    // A parse error invalidates all traces from the file, not just the malformed node.
    if ((sf as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) continue;
    const names = moduleBindings(sf), sourceHash = hash(source.text);
    const emit = (node: ts.Node, data: Omit<ReviewFact, 'id' | 'file' | 'startLine' | 'endLine' | 'sourceHash'>) => {
      if (facts.length >= 64) return;
      const fields = { ...data, file: source.file, startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1, sourceHash };
      facts.push({ id: `fact-${hash(JSON.stringify(fields)).slice(0, 20)}`, ...fields });
    };
    for (const node of sf.statements) if (ts.isFunctionDeclaration(node) && node.name) {
      const groups = new Map<string, string[]>();
      for (const input of traceInputs) {
        const result = tracePrimitive(node, input, names);
        if (!result || result.assertion.length > 100) continue;
        const inputs = groups.get(result.assertion) ?? []; inputs.push(describeInput(input)); groups.set(result.assertion, inputs);
      }
      for (const [assertion, inputs] of groups) emit(node, { kind: 'primitive-trace', symbol: node.name.text, assertion, inputs,
        assumptions: ['Only the listed primitive inputs; no claim about other inputs.', 'Undeclared names are absent from runtime globals; standard builtins are unmodified.', 'Bounded static AST trace, not runtime execution or whole-program verification.'] });
    }
    if (!isTestFile(source.file)) continue;
    const visit = (node: ts.Node) => {
      // Direct assert(fn(literal)) / assert.equal(fn(literal), expected).
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const assertion = ts.isIdentifier(callee) && callee.text === 'assert' || ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'assert' && ['equal', 'strictEqual', 'ok'].includes(callee.name.text);
        const call = node.arguments[0];
        if (assertion && call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.arguments.length === 1) {
          const value = literal(call.arguments[0]!);
          if (value) emit(node, { kind: 'assertion-inputs', symbol: call.expression.text, assertion: 'present', values: [value.value], assumptions: ['Source contains this assertion input. This does not prove it executes or establishes semantic coverage.'] });
        }
        // Fixture table + forEach callback containing assert(fn(parameter)).
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'forEach' && ts.isIdentifier(callee.expression)) {
          const callback = node.arguments[0];
          if (callback && (ts.isFunctionExpression(callback) || ts.isArrowFunction(callback)) && callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)) {
            const parameter = callback.parameters[0].name.text, table = callee.expression.text;
            let scope: ts.Node | undefined = node.parent;
            let initializer: ts.ArrayLiteralExpression | undefined;
            while (scope && !initializer) {
              if (ts.isBlock(scope) || ts.isSourceFile(scope)) for (const statement of scope.statements) if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === table && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) initializer = declaration.initializer;
              }
              scope = scope.parent;
            }
            if (initializer) {
              const values = initializer.elements.flatMap((element) => { const value = literal(element); return value ? [value.value] : []; }).slice(0, 256);
              const assertions = (child: ts.Node) => {
                if ((ts.isFunctionExpression(child) || ts.isArrowFunction(child) || ts.isFunctionDeclaration(child)) && child.parameters.some((p) => bindingNames(p.name).includes(parameter))) return;
                if (ts.isBlock(child) && child.statements.some((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => bindingNames(d.name).includes(parameter)))) return;
                if (ts.isCallExpression(child)) {
                  const isAssert = ts.isIdentifier(child.expression) && child.expression.text === 'assert' || ts.isPropertyAccessExpression(child.expression) && ts.isIdentifier(child.expression.expression) && child.expression.expression.text === 'assert' && ['equal', 'strictEqual', 'ok'].includes(child.expression.name.text);
                  const tested = child.arguments[0];
                  if (isAssert && tested && ts.isCallExpression(tested) && ts.isIdentifier(tested.expression) && tested.arguments.length === 1 && ts.isIdentifier(tested.arguments[0]!) && tested.arguments[0]!.text === parameter && values.length) {
                    emit(child, { kind: 'assertion-inputs', symbol: tested.expression.text, assertion: 'present', values,
                      assumptions: ['Source defines these fixture literals and a forEach callback asserting this parameter.', 'No claim that the callback executes, values are unmodified, or behavior is fully covered.'] });
                  }
                }
                ts.forEachChild(child, assertions);
              };
              assertions(callback.body);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return facts;
}
