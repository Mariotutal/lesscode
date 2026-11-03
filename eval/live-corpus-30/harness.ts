/** Retired evaluator: inspect legacy evidence without executing checkouts or models. */
import { readFileSync } from 'node:fs';
import { inspectLegacyEvidence } from './integrity.js';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')) as unknown;
const results = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8')) as unknown;
console.log(JSON.stringify(inspectLegacyEvidence(manifest, results), null, 2));
console.error('Evaluation refused: legacy results are invalid. See eval/live-corpus-30/README.md.');
process.exitCode = 1;
