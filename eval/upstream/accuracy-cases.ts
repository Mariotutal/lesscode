/** Synthetic holdouts: runtime and assertion facts are independent of model output. */
export interface AccuracyCase {
  id: string; base: string; head: string; tests: string;
  baseProbe: string; headProbe: string;
  facts: string[];
}
const feeBase = "export function fee(amount) {\n  if (Math.sign(amount) === -1) throw new RangeError('negative');\n  return amount * 2;\n}\n";
const feeHead = "export function fee(amount) {\n  if (amount < 0) throw new RangeError('negative');\n  return amount * 2;\n}\n";
const positiveFeeTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fee } from '../src/module.js';\ntest('positive fee', () => assert.equal(fee(3), 6));\n";
const feeProbe = "const {fee}=await import('./src/module.js'); assert.equal(fee(3),6); assert.throws(()=>fee(-2),RangeError);";
const guarded = (arg: string) => `export function classify(${arg}) {\n  if (typeof unknownValue === 'number') return unknownValue;\n  return false;\n}\n`;

export const accuracyCases: readonly AccuracyCase[] = [
  {
    id: 'negative-branch-covered', base: feeBase, head: feeHead,
    tests: positiveFeeTest + "test('negative fee', () => assert.throws(() => fee(-2), RangeError));\n",
    baseProbe: feeProbe, headProbe: feeProbe,
    facts: ['Both revisions reject negative inputs with RangeError.', 'The supplied tests explicitly exercise the negative branch.', 'The refactor does not introduce that rejection behavior.'],
  },
  {
    id: 'negative-branch-uncovered', base: feeBase, head: feeHead, tests: positiveFeeTest,
    baseProbe: feeProbe, headProbe: feeProbe,
    facts: ['Both revisions reject negative inputs with RangeError.', 'The supplied tests do not exercise negative inputs.', 'The missing test is pre-existing, not a new regression.'],
  },
  {
    id: 'guarded-unbound-name', base: guarded('value'), head: guarded('candidate'),
    tests: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { classify } from '../src/module.js';\ntest('classify', () => assert.equal(classify(3), false));\n",
    baseProbe: "const {classify}=await import('./src/module.js'); assert.equal(classify(3),false);",
    headProbe: "const {classify}=await import('./src/module.js'); assert.equal(classify(3),false);",
    facts: ['Both revisions return false without throwing in the normal module environment.', 'The unbound name is pre-existing.', 'A wrong variable name does not by itself establish ReferenceError; the branch is unreachable after typeof returns undefined.'],
  },
  {
    id: 'unguarded-unbound-name',
    base: "export function choose(value) {\n  if (value > 0) return value;\n  return 0;\n}\n",
    head: "export function choose(value) {\n  if (value > 0) return value;\n  return unknownValue;\n}\n",
    tests: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { choose } from '../src/module.js';\ntest('positive choice', () => assert.equal(choose(3), 3));\n",
    baseProbe: "const {choose}=await import('./src/module.js'); assert.equal(choose(0),0);",
    headProbe: "const {choose}=await import('./src/module.js'); assert.throws(()=>choose(0),ReferenceError);",
    facts: ['The head introduces ReferenceError for zero and negative inputs.', 'The upstream-style tests cover only positive inputs and still pass.', 'This is a positive control for useful detection; an empty note is not evidence of high recall.'],
  },
];
