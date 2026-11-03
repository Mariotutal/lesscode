import { describe, expect, it } from 'vitest';
import { collectReviewFacts } from '../src/review/factCatalog.js';
import { verifyReviewItem } from '../src/review/verifyClaims.js';
import type { ReviewNoteItem } from '../src/plan/schema.js';
import { runInNewContext } from 'node:vm';

const catalog = (text: string, file = 'src/module.js') => collectReviewFacts([{ file, text, lines: text.split('\n') }]);
const guarded = "export function classify(candidate) {\n if(typeof (unknownValue) === 'number') return unknownValue;\n return false;\n}\n";
const note = (claims: ReviewNoteItem['claims'] = []): ReviewNoteItem => ({ kind: 'question', text: 'This definitely throws ReferenceError.', citations: [{ file: 'src/module.js', startLine: 1, endLine: 4 }], claims });

describe('code-derived factual verification', () => {
  it('contradicts the known false exception claim, including parenthesized typeof', () => {
    const facts = catalog(guarded);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.assertion).toBe('returns:false');
    const result = verifyReviewItem(note([{ factId: facts[0]!.id, assertion: 'throws:ReferenceError' }]), facts);
    expect(result.item).toBeUndefined();
    expect(result.checks[0]!.status).toBe('contradicted');
  });
  it('verifies a real reachable ReferenceError without blanket word filtering', () => {
    const facts = catalog('export function choose(value) { if(value>0) return value; return unknownValue; }');
    const fact = facts.find((f) => f.assertion === 'throws:ReferenceError')!;
    expect(fact.inputs).toEqual(['-1', '0']);
    const result = verifyReviewItem(note([{ factId: fact.id, assertion: 'throws:ReferenceError' }]), facts);
    expect(result.item?.verification?.status).toBe('verified');
    expect(result.item?.text).toContain('throws:ReferenceError');
    expect(result.item?.text).toContain('no claim about other inputs');
  });
  it('does not certify false prose attached to a true structured claim', () => {
    const facts = catalog(guarded);
    const result = verifyReviewItem(note([{ factId: facts[0]!.id, assertion: 'returns:false' }]), facts);
    expect(result.item?.verification?.status).toBe('verified');
    expect(result.item?.text).not.toContain('definitely throws');
    expect(result.item?.text).toContain('returns:false');
  });
  it('normalizes equivalent scalar assertions instead of calling them contradictions', () => {
    const facts = catalog('export function f(x) { return 1; }');
    expect(verifyReviewItem(note([{ factId: facts[0]!.id, assertion: 'returns:1.0' }]), facts).item?.verification?.status).toBe('verified');
    expect(verifyReviewItem(note([{ factId: facts[0]!.id, assertion: 'returns:anything' }]), facts).checks[0]?.status).toBe('unverified');
  });
  it('keeps legacy advice explicitly unverified and rejects invented/miscited facts', () => {
    const facts = catalog(guarded);
    expect(verifyReviewItem(note(), facts).item?.verification?.status).toBe('unverified');
    expect(verifyReviewItem(note([{ factId: 'invented', assertion: 'returns:false' }]), facts).item).toBeUndefined();
    const wrong = { ...note([{ factId: facts[0]!.id, assertion: 'returns:false' }]), citations: [{ file: 'other.js', startLine: 1, endLine: 4 }] };
    expect(verifyReviewItem(wrong, facts).item).toBeUndefined();
  });
  it('never upgrades a mixed verified and unsupported item', () => {
    const facts = catalog(guarded);
    const result = verifyReviewItem(note([{ factId: facts[0]!.id, assertion: 'returns:false' }, { factId: 'invented', assertion: 'present' }]), facts);
    expect(result.item).toBeUndefined();
    expect(result.checks.map((c) => c.status)).toEqual(['verified', 'unverified']);
  });
  it.each([
    'export function f(x) { return fetch(x); }',
    'export function f(x) { return console; }',
    'export function f(x) { return arguments; }',
    'export function f(x) { let unknownValue; return unknownValue; }',
    'export function f(x) { return unknownValue = 1; }',
    'export function f(x) { return (() => unknownValue)(); }',
    'export function f(x) { while(x) {} return x; }',
    'let unknownValue; export function f(x) { return unknownValue; }',
    'if(true) { var unknownValue = 1; } export function f(x) { return unknownValue; }',
    'import {unknownValue} from "./external.js"; export function f(x) { return unknownValue; }',
    'export function f(x) { return obj.value; }',
  ])('declines unsupported/ambient behavior: %s', (text) => {
    expect(catalog(text)).toEqual([]);
  });
  it('does not produce facts from malformed or sealed source', () => {
    expect(catalog('export function f(x) { return (')).toEqual([]);
    expect(catalog(guarded, 'fixtures/1/sealed/truth.js')).toEqual([]);
  });
  it('binds fact identities to exact source and preserves explicit assumptions', () => {
    const first = catalog(guarded)[0]!;
    const second = catalog(guarded + '// different revision\n')[0]!;
    expect(first.id).not.toBe(second.id);
    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(first.assumptions.join(' ')).toContain('runtime globals');
  });
  it('does not claim exceptions in unreachable short-circuit branches', () => {
    expect(catalog('export function f(x) { return false && unknownValue; }')[0]!.assertion).toBe('returns:false');
    expect(catalog('export function f(x) { return true || unknownValue; }')[0]!.assertion).toBe('returns:true');
  });
  it('does not execute repository expressions while analyzing source', () => {
    const key = '__lesscode_fact_test';
    expect(catalog(`export function f(x) { return globalThis.${key} = 1; }`)).toEqual([]);
    expect((globalThis as Record<string, unknown>)[key]).toBeUndefined();
  });
  it('detects fixture assertion inputs, not comments or arbitrary strings', () => {
    const text = "// missing 'Infinity'\ndescribe('numbers', function(){ const fixtures=['0e+5','0xff',3]; fixtures.forEach(function(num){ it('case',function(){ assert(isNumber(num)); }); }); });\n";
    const facts = catalog(text, 'test.js');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.values).toEqual(['0e+5', '0xff', 3]);
    const item = { ...note([{ factId: facts[0]!.id, assertion: 'absent', value: '0e+5' }]), citations: [{ file: 'test.js', startLine: 2, endLine: 2 }] };
    expect(verifyReviewItem(item, facts).checks[0]!.status).toBe('contradicted');
    expect(verifyReviewItem({ ...item, claims: [{ factId: facts[0]!.id, assertion: 'absent', value: 'Infinity' }] }, facts).checks[0]!.status).toBe('unverified');
  });
  it('renders direct assertion evidence without claiming execution or whole-repo coverage', () => {
    const facts = catalog("assert.equal(isNumber('0e+5'),true);", 'tests/number.test.js');
    const item = { ...note([{ factId: facts[0]!.id, assertion: 'present', value: '0e+5' }]), citations: [{ file: 'tests/number.test.js', startLine: 1, endLine: 1 }] };
    const verified = verifyReviewItem(item, facts).item!;
    expect(verified.verification?.status).toBe('verified');
    expect(verified.text).toContain('not execution or complete coverage');
  });
  it('cross-checks bounded traces against real JS on trusted, fixed test programs', () => {
    const programs = [
      'function f(x) { if(typeof (missing)==="number") return missing; return false; }',
      'function f(x) { if(x>0) return x; return missing; }',
      'function f(x) { return x === null ? 1 : 0; }',
      'function f(x) { return !x; }',
      'function f(x) { return false && missing; }',
      'function f(x) { return true || missing; }',
      'function f(x) { if(x<0) throw new RangeError("negative"); return x*2; }',
      'function f(x) { return Number.isFinite(x); }',
      'function f(x) { return +x; }',
      'function f(x) { return x ?? 7; }',
    ];
    for (const program of programs) {
      const facts = catalog(program);
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) for (const input of fact.inputs!) {
        // Only these literal test programs execute here; production never uses eval/vm.
        const observation = runInNewContext(`${program}; (()=>{try { const v=f(${input}); return { value:v }; } catch(e) { return { error:e.name }; }})()`, {}, { timeout: 100 }) as { value?: unknown; error?: string };
        const expected = observation.error ? `throws:${observation.error}` : `returns:${observation.value === undefined ? 'undefined' : typeof observation.value === 'number' && Object.is(observation.value, -0) ? '-0' : typeof observation.value === 'number' && !Number.isFinite(observation.value) ? String(observation.value) : JSON.stringify(observation.value)}`;
        expect(fact.assertion, `${program} for ${input}`).toBe(expected);
      }
    }
  });
});
