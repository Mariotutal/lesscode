/** Legacy summaries omit actual invocation records; they cannot certify a run. */
type Row = Record<string, unknown>;

function rows(value: unknown, label: string): Row[] {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${label} must be an array of objects`);
  }
  return value as Row[];
}

function pinned(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f\d]{40}$/i.test(value) && !/^(.)\1+$/.test(value);
}

export function inspectLegacyEvidence(manifest: unknown, results: unknown) {
  const cases = rows(manifest, 'manifest');
  const summary = results && typeof results === 'object' ? results as Row : {};
  const observations = rows(summary.results, 'results');
  const ids = new Set(cases.map((entry) => entry.id));
  return {
    status: 'invalid-evaluation' as const,
    usableForReleaseDecision: false as const,
    declaredCases: cases.length,
    recordedRows: observations.length,
    unpinnedCases: cases.filter((entry) => !pinned(entry.baseSha) || !pinned(entry.headSha)).map((entry) => entry.id),
    duplicateManifestIds: cases.length !== ids.size,
    missingResults: cases.filter((entry) => !observations.some((row) => row.id === entry.id)).map((entry) => entry.id),
    unexpectedResults: observations.filter((row) => !ids.has(row.id)).map((row) => row.id),
    reasons: [
      'Legacy summaries lack independently captured canonical records and invocation provenance.',
      'The retired harness generated synthetic repositories rather than checking out the named upstream projects.',
      'Its live mode copied guest verdicts to MCP and could fabricate CLI records; guest calls were scripted by default.',
      'Expected-match and envelope flags, token counts, and sealNeverRead claims are not verified evidence.',
    ],
  };
}
