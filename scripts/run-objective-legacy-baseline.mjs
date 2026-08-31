#!/usr/bin/env node
// Fixed same-model baseline for the paid Objective V1 release gate. It never changes treatment
// records and compares one complete legacy run against an already archived 240-call treatment.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeObjectiveResult, normalizeObjectiveAnswer } from '../server/src/objective-result.ts';
import { objectiveEvalAnswerHit } from '../server/src/objective-eval-scoring.ts';

if (process.env.NSPI_RUN_OBJECTIVE_EVAL !== '1') {
  console.error('Set NSPI_RUN_OBJECTIVE_EVAL=1 to run the paid 240-call baseline.');
  process.exit(2);
}
const required = ['NSPI_EVAL_BASE_URL', 'NSPI_EVAL_DEVICE_TOKEN', 'NSPI_EVAL_MODEL',
  'NSPI_EVAL_COMMIT', 'NSPI_EVAL_APP_VERSION', 'NSPI_EVAL_EXECUTOR', 'NSPI_EVAL_REVIEWER',
  'NSPI_EVAL_TREATMENT_SUMMARY', 'NSPI_EVAL_TREATMENT_JSONL'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(root, 'Tests/Fixtures/objective-v1');
const manifestText = await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const manifestSHA256 = createHash('sha256').update(manifestText).digest('hex');
if (manifest.fixtures.length !== 240) throw new Error('manifest must contain exactly 240 fixtures');
for (const fixture of manifest.fixtures) {
  const image = await readFile(resolve(fixtureRoot, fixture.image));
  const digest = createHash('sha256').update(image).digest('hex');
  if (digest !== fixture.sha256) throw new Error(`fixture ${fixture.id} sha256 mismatch`);
}

const system = execFileSync('swift', ['run', 'NotchSPI', '--print-legacy-eval-prompt'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const task = execFileSync('swift', ['run', 'NotchSPI', '--print-legacy-eval-task'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const baseURL = process.env.NSPI_EVAL_BASE_URL.replace(/\/$/u, '');
const outputDir = resolve(root, 'objective-eval-output');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const prefix = `${stamp}-legacy`;
const jsonl = resolve(outputDir, `${prefix}.jsonl`);
const records = [];

for (const [index, fixture] of manifest.fixtures.entries()) {
  const image = (await readFile(resolve(fixtureRoot, fixture.image))).toString('base64');
  const started = performance.now();
  const response = await fetch(`${baseURL}/v1/captures`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.NSPI_EVAL_DEVICE_TOKEN}`,
      'content-type': 'application/json', 'x-app-version': process.env.NSPI_EVAL_APP_VERSION,
    },
    body: JSON.stringify({
      system, task, image_base64: image, image_media_type: 'image/png',
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`fixture ${fixture.id} failed with HTTP ${response.status}`);
  const events = body.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
    try { return [JSON.parse(line.slice(6))]; } catch { return []; }
  });
  const raw = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
  const usage = events.find((event) => event.type === 'usage');
  const streamError = events.find((event) => event.type === 'error');
  if (streamError || !usage) throw new Error(`fixture ${fixture.id} ended without a usage result`);
  const parsed = composeObjectiveResult(raw, false);
  const answerHit = fixture.expected_state === 'retake'
    ? null
    : objectiveEvalAnswerHit(parsed.finalAnswer, fixture.accepted_answers);
  const record = {
    id: fixture.id, language: fixture.language, kind: fixture.kind,
    expected_state: fixture.expected_state, schema_valid: null, actual_state: null,
    parser_path: parsed.parserPath, answer_hit: answerHit, state_match: null,
    normalized_answer: parsed.finalAnswer ? normalizeObjectiveAnswer(parsed.finalAnswer) : null,
    input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
    total_ms: Math.round(performance.now() - started), model: process.env.NSPI_EVAL_MODEL,
    prompt_variant: 'legacy', prompt_version: `legacy-brief-${process.env.NSPI_EVAL_APP_VERSION}`,
    manifest_sha256: manifestSHA256, commit: process.env.NSPI_EVAL_COMMIT,
    app_version: process.env.NSPI_EVAL_APP_VERSION, executor: process.env.NSPI_EVAL_EXECUTOR,
    reviewer: process.env.NSPI_EVAL_REVIEWER,
  };
  records.push(record);
  await appendFile(jsonl, `${JSON.stringify(record)}\n`);
  const label = answerHit === null ? 'reference-only' : answerHit ? '✓' : '✗';
  console.log(`[${index + 1}/240] ${fixture.id}: ${record.parser_path} ${label}`);
}

const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const answerable = records.filter((record) => record.expected_state !== 'retake');
const baseline = {
  generated_at: new Date().toISOString(), calls: records.length, variant: 'legacy',
  manifest_sha256: manifestSHA256, model: process.env.NSPI_EVAL_MODEL,
  answerable_accuracy: ratio(answerable.filter((record) => record.answer_hit).length, answerable.length),
  by_kind: Object.fromEntries([...new Set(answerable.map((record) => record.kind))].map((kind) => [kind,
    ratio(answerable.filter((record) => record.kind === kind && record.answer_hit).length,
      answerable.filter((record) => record.kind === kind).length)])),
  by_language: Object.fromEntries([...new Set(answerable.map((record) => record.language))].map((language) => [language,
    ratio(answerable.filter((record) => record.language === language && record.answer_hit).length,
      answerable.filter((record) => record.language === language).length)])),
  avg_tokens: average(records.flatMap((record) => record.input_tokens === null || record.output_tokens === null
    ? [] : [record.input_tokens + record.output_tokens])),
  p95_total_ms: records.map((record) => record.total_ms).sort((a, b) => a - b)[Math.ceil(records.length * .95) - 1],
};
const baselineSummary = `${prefix}-summary.json`;
await writeFile(resolve(outputDir, baselineSummary), `${JSON.stringify(baseline, null, 2)}\n`);
await writeFile(resolve(outputDir, `${prefix}-summary.md`), `# Objective evaluation — legacy\n\n`
  + `- Calls: ${baseline.calls}\n- Answerable accuracy: ${(baseline.answerable_accuracy * 100).toFixed(2)}%\n`
  + `- Average tokens: ${baseline.avg_tokens.toFixed(2)}\n- p95 total: ${baseline.p95_total_ms} ms\n`);

const treatmentSummaryPath = resolve(root, process.env.NSPI_EVAL_TREATMENT_SUMMARY);
const treatmentJSONLPath = resolve(root, process.env.NSPI_EVAL_TREATMENT_JSONL);
const treatment = JSON.parse(await readFile(treatmentSummaryPath, 'utf8'));
const treatmentRows = (await readFile(treatmentJSONLPath, 'utf8')).trim().split('\n').map(JSON.parse);
if (treatmentRows.length !== 240) throw new Error('treatment JSONL must contain 240 rows');
const treatmentModels = new Set(treatmentRows.map((row) => row.model));
if (treatmentModels.size !== 1 || !treatmentModels.has(process.env.NSPI_EVAL_MODEL)) {
  throw new Error('baseline and treatment models differ');
}
const treatmentCommits = new Set(treatmentRows.map((row) => row.commit));
if (treatmentCommits.size !== 1) throw new Error('treatment JSONL contains multiple commits');
const treatmentManifest = execFileSync('git', [
  'show', `${[...treatmentCommits][0]}:Tests/Fixtures/objective-v1/manifest.json`,
], { cwd: root });
if (createHash('sha256').update(treatmentManifest).digest('hex') !== manifestSHA256) {
  throw new Error('baseline and treatment manifests differ');
}

const accuracyDelta = treatment.answerable_accuracy - baseline.answerable_accuracy;
const tokenIncrease = treatment.avg_tokens / baseline.avg_tokens - 1;
const p95Increase = treatment.p95_total_ms / baseline.p95_total_ms - 1;
const failures = [];
if (accuracyDelta < -0.01) failures.push('answerable accuracy regression > 1 percentage point');
if (tokenIncrease > 0.08) failures.push('average token increase > 8%');
if (p95Increase > 0.10) failures.push('p95 latency increase > 10%');
const comparison = {
  generated_at: new Date().toISOString(), status: 'pending_owner_review',
  manifest_sha256: manifestSHA256, model: process.env.NSPI_EVAL_MODEL,
  baseline: { source: `objective-eval-output/${baselineSummary}`, ...baseline },
  treatment: { source: process.env.NSPI_EVAL_TREATMENT_SUMMARY,
    answerable_accuracy: treatment.answerable_accuracy, avg_tokens: treatment.avg_tokens,
    p95_total_ms: treatment.p95_total_ms },
  deltas: { accuracy_percentage_points: accuracyDelta * 100,
    average_tokens_ratio: tokenIncrease, p95_latency_ratio: p95Increase },
  thresholds: { max_accuracy_regression_percentage_points: 1,
    max_average_tokens_ratio: 0.08, max_p95_latency_ratio: 0.10 },
  failures,
};
await writeFile(resolve(outputDir, `${prefix}-comparison.json`), `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(resolve(outputDir, `${prefix}-comparison.md`), `# Objective V1 vs fixed legacy baseline\n\n`
  + `- Status: PENDING OWNER REVIEW\n- Model: ${comparison.model}\n- Manifest: ${manifestSHA256}\n`
  + `- Accuracy: baseline ${(baseline.answerable_accuracy * 100).toFixed(2)}% → treatment ${(treatment.answerable_accuracy * 100).toFixed(2)}% (${(accuracyDelta * 100).toFixed(2)} pp)\n`
  + `- Average tokens: baseline ${baseline.avg_tokens.toFixed(2)} → treatment ${treatment.avg_tokens.toFixed(2)} (${(tokenIncrease * 100).toFixed(2)}%)\n`
  + `- p95 latency: baseline ${baseline.p95_total_ms} ms → treatment ${treatment.p95_total_ms} ms (${(p95Increase * 100).toFixed(2)}%)\n`
  + `- Gate: ${failures.length ? `FAIL — ${failures.join('; ')}` : 'PASS'}\n`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
