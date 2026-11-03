import type { ReviewNoteItem } from '../plan/schema.js';
import type { ClaimCheck, ReviewFact } from './claims.js';

function normalizeTraceAssertion(assertion: string): string | undefined {
  if (/^throws:(Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError)$/.test(assertion)) return assertion;
  if (!assertion.startsWith('returns:')) return;
  const value = assertion.slice(8);
  if (['undefined', 'NaN', 'Infinity', '-Infinity', '-0'].includes(value)) return `returns:${value}`;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && !['string', 'number', 'boolean'].includes(typeof parsed)) return;
    return `returns:${typeof parsed === 'number' && Object.is(parsed, -0) ? '-0' : typeof parsed === 'number' && !Number.isFinite(parsed) ? String(parsed) : JSON.stringify(parsed)}`;
  } catch { return; }
}

/** A model's narrative is never promoted to verified by its own claims. */
export function verifyReviewItem(item: ReviewNoteItem, facts: readonly ReviewFact[]): { item?: ReviewNoteItem; checks: ClaimCheck[]; reason?: string } {
  const claims = item.claims ?? [];
  if (!claims.length) return { item: { ...item, verification: { status: 'unverified', basis: 'unstructured-model-advice', claims: [] } }, checks: [] };
  const statements: string[] = [];
  const citations: ReviewNoteItem['citations'] = [];
  const checks: ClaimCheck[] = claims.map((claim) => {
    const fact = facts.find((f) => f.id === claim.factId);
    if (!fact) return { ...claim, status: 'unverified', reason: 'unknown or unavailable fact ID' };
    if (!item.citations.some((c) => c.file === fact.file && c.startLine <= fact.endLine && c.endLine >= fact.startLine)) return { ...claim, status: 'unverified', reason: 'claim does not cite its supporting fact' };
    if (fact.kind === 'assertion-inputs') {
      if (claim.value === undefined || !fact.values?.some((v) => Object.is(v, claim.value))) return { ...claim, status: 'unverified', reason: 'no source-presence evidence for this exact input; absence is not established' };
      if (claim.assertion !== 'present' && claim.assertion !== 'absent') return { ...claim, status: 'unverified', reason: 'unsupported assertion predicate' };
      if (claim.assertion === 'absent') return { ...claim, status: 'contradicted', reason: 'the supplied assertion source contains this input' };
      const value = Object.is(claim.value, -0) ? '-0' : JSON.stringify(claim.value);
      statements.push(`${fact.file}:${fact.startLine}-${fact.endLine} contains an assertion-shaped source call for ${fact.symbol} with fixture literal ${value}. This proves source presence, not execution or complete coverage.`);
    } else {
      if (claim.value !== undefined) return { ...claim, status: 'unverified', reason: 'trace inputs are fixed by the fact ID and cannot be overridden' };
      const assertion = normalizeTraceAssertion(claim.assertion);
      if (!assertion) return { ...claim, status: 'unverified', reason: 'unsupported trace predicate' };
      if (assertion !== fact.assertion) return { ...claim, status: 'contradicted', reason: `bounded trace establishes ${fact.assertion}, not ${assertion}` };
      statements.push(`Bounded static trace of ${fact.symbol} in ${fact.file} with inputs [${fact.inputs?.join(', ')}] establishes ${fact.assertion}. Assumes undeclared globals are absent and standard builtins are unmodified; no claim about other inputs or runtime execution.`);
    }
    citations.push({ file: fact.file, startLine: fact.startLine, endLine: fact.endLine });
    return { ...claim, status: 'verified', reason: 'matches code-derived evidence within its stated scope' };
  });
  if (checks.some((c) => c.status !== 'verified')) return { checks, reason: checks.some((c) => c.status === 'contradicted') ? 'contradicted factual claim' : 'unverified factual claim' };
  // Drop free narrative even if the model attached a true claim to false prose.
  return { item: { ...item, text: [...new Set(statements)].join(' '), citations, verification: { status: 'verified', basis: 'code-rendered-facts', claims: checks } }, checks };
}
