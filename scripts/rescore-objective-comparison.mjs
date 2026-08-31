#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { summarizeAnswerable } from './objective-eval-scoring.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  if (index < 1) throw new Error('arguments must use --name=path');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
for (const key of ['baseline', 'treatment']) if (!args[key]) throw new Error(`--${key}=path is required`);

const manifestText = await readFile(resolve(root, 'Tests/Fixtures/objective-v1/manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const manifestSHA256 = createHash('sha256').update(manifestText).digest('hex');
const loadJSONL = async (path) => (await readFile(resolve(root, path), 'utf8')).trim().split('\n')
  .map((line) => JSON.parse(line));
const baselineRows = await loadJSONL(args.baseline);
const treatmentRows = await loadJSONL(args.treatment);
if (baselineRows.length !== 240 || treatmentRows.length !== 240) {
  throw new Error('baseline and treatment JSONL must each contain 240 rows');
}
const models = new Set([...baselineRows, ...treatmentRows].map((row) => row.model));
if (models.size !== 1) throw new Error('baseline and treatment models differ');
const baseline = summarizeAnswerable(baselineRows, manifest.fixtures);
const treatment = summarizeAnswerable(treatmentRows, manifest.fixtures);
const accuracyDelta = treatment.answerable_accuracy - baseline.answerable_accuracy;
const tokenIncrease = treatment.avg_tokens / baseline.avg_tokens - 1;
const p95Increase = treatment.p95_total_ms / baseline.p95_total_ms - 1;
const failures = [];
if (accuracyDelta < -.01) failures.push('answerable accuracy regression > 1 percentage point');
if (tokenIncrease > .08) failures.push('average token increase > 8%');
if (p95Increase > .10) failures.push('p95 latency increase > 10%');
const comparison = {
  generated_at: new Date().toISOString(), scoring_version: 'objective-semantic-v1',
  status: 'pending_independent_review', manifest_sha256: manifestSHA256,
  model: [...models][0],
  baseline: { source: args.baseline, answerable_accuracy: baseline.answerable_accuracy,
    by_kind: baseline.by_kind, by_language: baseline.by_language,
    avg_tokens: baseline.avg_tokens, p95_total_ms: baseline.p95_total_ms },
  treatment: { source: args.treatment, answerable_accuracy: treatment.answerable_accuracy,
    by_kind: treatment.by_kind, by_language: treatment.by_language,
    avg_tokens: treatment.avg_tokens, p95_total_ms: treatment.p95_total_ms },
  deltas: { accuracy_percentage_points: accuracyDelta * 100,
    average_tokens_ratio: tokenIncrease, p95_latency_ratio: p95Increase },
  thresholds: { max_accuracy_regression_percentage_points: 1,
    max_average_tokens_ratio: .08, max_p95_latency_ratio: .10 },
  failures,
};
const prefix = resolve(root, dirname(args.baseline),
  basename(args.baseline, '.jsonl').replace(/-legacy$/u, '-semantic'));
const semanticBaselinePath = `${prefix}-baseline.jsonl`;
const baselineSummaryPath = `${prefix}-baseline-summary.json`;
comparison.baseline.source = semanticBaselinePath.slice(root.length + 1);
await writeFile(semanticBaselinePath, `${baseline.records.map((record) => JSON.stringify(record)).join('\n')}\n`);
await writeFile(baselineSummaryPath, `${JSON.stringify({
  generated_at: comparison.generated_at,
  scoring_version: comparison.scoring_version,
  calls: baseline.records.length,
  variant: 'legacy',
  manifest_sha256: manifestSHA256,
  model: comparison.model,
  answerable_accuracy: baseline.answerable_accuracy,
  by_kind: baseline.by_kind,
  by_language: baseline.by_language,
  avg_tokens: baseline.avg_tokens,
  p95_total_ms: baseline.p95_total_ms,
}, null, 2)}\n`);
await writeFile(`${prefix}-baseline-summary.md`, `# Fixed legacy baseline — semantic scoring\n\n`
  + `- Calls: ${baseline.records.length}\n- Scoring: ${comparison.scoring_version}\n`
  + `- Answerable accuracy: ${(baseline.answerable_accuracy * 100).toFixed(2)}%\n`
  + `- Average tokens: ${baseline.avg_tokens.toFixed(2)}\n`
  + `- p95 total: ${baseline.p95_total_ms} ms\n`);
await writeFile(`${prefix}-comparison.json`, `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(`${prefix}-comparison.md`, `# Objective V1 vs fixed legacy baseline\n\n`
  + `- Scoring: ${comparison.scoring_version}\n- Status: PENDING INDEPENDENT REVIEW\n`
  + `- Model: ${comparison.model}\n- Manifest: ${manifestSHA256}\n`
  + `- Accuracy: baseline ${(baseline.answerable_accuracy * 100).toFixed(2)}% → treatment ${(treatment.answerable_accuracy * 100).toFixed(2)}% (${(accuracyDelta * 100).toFixed(2)} pp)\n`
  + `- Average tokens: baseline ${baseline.avg_tokens.toFixed(2)} → treatment ${treatment.avg_tokens.toFixed(2)} (${(tokenIncrease * 100).toFixed(2)}%)\n`
  + `- p95 latency: baseline ${baseline.p95_total_ms} ms → treatment ${treatment.p95_total_ms} ms (${(p95Increase * 100).toFixed(2)}%)\n`
  + `- Gate: ${failures.length ? `FAIL — ${failures.join('; ')}` : 'PASS'}\n`);
console.log(JSON.stringify(comparison, null, 2));
if (failures.length) process.exitCode = 1;
