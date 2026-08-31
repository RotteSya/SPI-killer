#!/usr/bin/env node
// Offline comparison of two immutable 240-call archives. Prompt-version metadata may differ, but
// the fixture payload (ids, expected answers, image hashes) and model must be identical.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NSPI_COMPARE_OBJECTIVE_EVALS !== '1') {
  console.error('Set NSPI_COMPARE_OBJECTIVE_EVALS=1 to compare archived evaluations.');
  process.exit(2);
}
const required = ['NSPI_BASELINE_SUMMARY', 'NSPI_BASELINE_JSONL',
  'NSPI_TREATMENT_SUMMARY', 'NSPI_TREATMENT_JSONL'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loadJSON = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const loadRows = async (path) => (await readFile(resolve(root, path), 'utf8'))
  .trim().split('\n').map(JSON.parse);
const baseline = await loadJSON(process.env.NSPI_BASELINE_SUMMARY);
const treatment = await loadJSON(process.env.NSPI_TREATMENT_SUMMARY);
const baselineRows = await loadRows(process.env.NSPI_BASELINE_JSONL);
const treatmentRows = await loadRows(process.env.NSPI_TREATMENT_JSONL);
if (baselineRows.length !== 240 || treatmentRows.length !== 240) {
  throw new Error('both archives must contain exactly 240 rows');
}

const only = (rows, key) => {
  const values = new Set(rows.map((row) => row[key]));
  if (values.size !== 1) throw new Error(`${key} is inconsistent inside an archive`);
  return [...values][0];
};
const baselineModel = only(baselineRows, 'model');
const treatmentModel = only(treatmentRows, 'model');
if (baselineModel !== treatmentModel) throw new Error('baseline and treatment models differ');
const baselineCommit = only(baselineRows, 'commit');
const treatmentCommit = only(treatmentRows, 'commit');
const fixtureDigest = (commit) => {
  const manifest = JSON.parse(execFileSync(
    'git', ['show', `${commit}:Tests/Fixtures/objective-v1/manifest.json`],
    { cwd: root, encoding: 'utf8' },
  ));
  return createHash('sha256').update(JSON.stringify({
    schema_version: manifest.schema_version, fixtures: manifest.fixtures,
  })).digest('hex');
};
const baselineFixtureSHA256 = fixtureDigest(baselineCommit);
const treatmentFixtureSHA256 = fixtureDigest(treatmentCommit);
if (baselineFixtureSHA256 !== treatmentFixtureSHA256) {
  throw new Error('baseline and treatment fixture sets differ');
}
if (treatment.failures?.length) throw new Error('treatment failed its absolute gate');

const accuracyDelta = treatment.answerable_accuracy - baseline.answerable_accuracy;
const tokenIncrease = treatment.avg_tokens / baseline.avg_tokens - 1;
const p95Increase = treatment.p95_total_ms / baseline.p95_total_ms - 1;
const failures = [];
if (accuracyDelta < -0.01) failures.push('answerable accuracy regression > 1 percentage point');
if (tokenIncrease > 0.08) failures.push('average token increase > 8%');
if (p95Increase > 0.10) failures.push('p95 latency increase > 10%');
const comparison = {
  generated_at: new Date().toISOString(), status: 'pending_owner_review',
  fixture_set_sha256: baselineFixtureSHA256, model: baselineModel,
  baseline: { source: process.env.NSPI_BASELINE_SUMMARY, commit: baselineCommit,
    answerable_accuracy: baseline.answerable_accuracy, avg_tokens: baseline.avg_tokens,
    p95_total_ms: baseline.p95_total_ms },
  treatment: { source: process.env.NSPI_TREATMENT_SUMMARY, commit: treatmentCommit,
    answerable_accuracy: treatment.answerable_accuracy, avg_tokens: treatment.avg_tokens,
    p95_total_ms: treatment.p95_total_ms },
  deltas: { accuracy_percentage_points: accuracyDelta * 100,
    average_tokens_ratio: tokenIncrease, p95_latency_ratio: p95Increase },
  thresholds: { max_accuracy_regression_percentage_points: 1,
    max_average_tokens_ratio: 0.08, max_p95_latency_ratio: 0.10 },
  failures,
};
const outputDir = resolve(root, 'objective-eval-output');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const prefix = `${stamp}-r5-vs-legacy-comparison`;
await writeFile(resolve(outputDir, `${prefix}.json`), `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(resolve(outputDir, `${prefix}.md`), `# Objective V1 r5 vs fixed legacy baseline\n\n`
  + `- Status: PENDING OWNER REVIEW\n- Model: ${baselineModel}\n- Fixture set: ${baselineFixtureSHA256}\n`
  + `- Accuracy: baseline ${(baseline.answerable_accuracy * 100).toFixed(2)}% → treatment ${(treatment.answerable_accuracy * 100).toFixed(2)}% (${(accuracyDelta * 100).toFixed(2)} pp)\n`
  + `- Average tokens: baseline ${baseline.avg_tokens.toFixed(2)} → treatment ${treatment.avg_tokens.toFixed(2)} (${(tokenIncrease * 100).toFixed(2)}%)\n`
  + `- p95 latency: baseline ${baseline.p95_total_ms} ms → treatment ${treatment.p95_total_ms} ms (${(p95Increase * 100).toFixed(2)}%)\n`
  + `- Gate: ${failures.length ? `FAIL — ${failures.join('; ')}` : 'PASS'}\n`);
console.log(JSON.stringify(comparison, null, 2));
if (failures.length) process.exit(1);
