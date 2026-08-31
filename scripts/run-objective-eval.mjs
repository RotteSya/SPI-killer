#!/usr/bin/env node
// Explicit, paid release gate. Never runs from normal CI: NSPI_RUN_OBJECTIVE_EVAL=1 is required.
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { composeObjectiveResult, normalizeObjectiveAnswer } from '../server/src/objective-result.ts';
import { matchesAcceptedAnswer } from './objective-eval-scoring.mjs';

if (process.env.NSPI_RUN_OBJECTIVE_EVAL !== '1') {
  console.error('Set NSPI_RUN_OBJECTIVE_EVAL=1 to run the paid 240-call release evaluation.');
  process.exit(2);
}
const variant = process.env.NSPI_EVAL_VARIANT ?? 'objective_v1';
if (!['objective_v1', 'legacy'].includes(variant)) {
  throw new Error('NSPI_EVAL_VARIANT must be objective_v1 or legacy');
}
const protocolEnabled = variant === 'objective_v1';
const registerDeviceCount = Number(process.env.NSPI_EVAL_REGISTER_DEVICES ?? '0');
if (!Number.isInteger(registerDeviceCount) || registerDeviceCount < 0 || registerDeviceCount > 4) {
  throw new Error('NSPI_EVAL_REGISTER_DEVICES must be an integer in 0...4');
}
const required = ['NSPI_EVAL_BASE_URL', 'NSPI_EVAL_MODEL',
  'NSPI_EVAL_COMMIT', 'NSPI_EVAL_APP_VERSION', 'NSPI_EVAL_EXECUTOR', 'NSPI_EVAL_REVIEWER'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
const suppliedTokens = (process.env.NSPI_EVAL_DEVICE_TOKEN ?? '')
  .split(',').map((token) => token.trim()).filter(Boolean);
if (suppliedTokens.length === 0 && registerDeviceCount === 0) {
  throw new Error('NSPI_EVAL_DEVICE_TOKEN or NSPI_EVAL_REGISTER_DEVICES is required');
}
if (process.env.NSPI_EVAL_VERCEL_SHARE_TOKEN && process.env.NSPI_EVAL_VERCEL_BYPASS_TOKEN) {
  throw new Error('use only one Vercel protection credential');
}

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
const outputDir = resolve(root, 'objective-eval-output');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const outputPrefix = `${stamp}-${variant}`;
const jsonl = resolve(outputDir, `${outputPrefix}.jsonl`);
const baseURL = process.env.NSPI_EVAL_BASE_URL.replace(/\/$/, '');

// Preview deployments stay protected. A temporary Vercel share token is exchanged once for the
// HttpOnly deployment cookie, then every evaluation request carries that cookie. Production or
// otherwise-unprotected candidates omit NSPI_EVAL_VERCEL_SHARE_TOKEN and use no extra header.
const evaluationHeaders = {};
if (process.env.NSPI_EVAL_VERCEL_BYPASS_TOKEN) {
  evaluationHeaders['x-vercel-protection-bypass'] = process.env.NSPI_EVAL_VERCEL_BYPASS_TOKEN;
}
if (process.env.NSPI_EVAL_VERCEL_SHARE_TOKEN) {
  const access = await fetch(
    `${baseURL}/?_vercel_share=${encodeURIComponent(process.env.NSPI_EVAL_VERCEL_SHARE_TOKEN)}`,
    { redirect: 'manual' },
  );
  const match = /(?:^|[, ])(_vercel_jwt=[^;]+)/u.exec(access.headers.get('set-cookie') ?? '');
  if (!match) throw new Error('Vercel share token did not produce a deployment access cookie');
  evaluationHeaders.cookie = match[1];
}

// Read the prompt from the Swift SSOT rather than maintaining an evaluation-only copy.
const promptFlag = protocolEnabled ? '--print-objective-eval-prompt' : '--print-legacy-eval-prompt';
const SYSTEM = execFileSync('swift', ['run', 'NotchSPI', promptFlag], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();

const deviceTokens = [...suppliedTokens];
for (let index = 0; index < registerDeviceCount; index += 1) {
  const response = await fetch(`${baseURL}/v1/devices`, {
    method: 'POST', headers: { ...evaluationHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'objective-eval', app_version: process.env.NSPI_EVAL_APP_VERSION }),
  });
  if (!response.ok) throw new Error(`isolated device registration failed with HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.device_token !== 'string' || !Number.isInteger(body.balance_questions)) {
    throw new Error('isolated device registration returned an invalid response');
  }
  deviceTokens.push(body.device_token);
}
const requiredCalls = deviceTokens.map((_, tokenIndex) =>
  Math.floor((manifest.fixtures.length - 1 - tokenIndex) / deviceTokens.length) + 1);
for (const [tokenIndex, token] of deviceTokens.entries()) {
  const response = await fetch(`${baseURL}/v1/account`, {
    headers: { ...evaluationHeaders, authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`evaluation device ${tokenIndex + 1} account failed with HTTP ${response.status}`);
  const account = await response.json();
  if (!Number.isInteger(account.balance_questions) || account.balance_questions < requiredCalls[tokenIndex]) {
    throw new Error(`evaluation device ${tokenIndex + 1} has insufficient isolated quota`);
  }
}
console.log(`Evaluation variant=${variant}; devices=${deviceTokens.length}; manifest=${manifestSHA256}`);

const records = [];
for (const [index, fixture] of manifest.fixtures.entries()) {
  const image = (await readFile(resolve(fixtureRoot, fixture.image))).toString('base64');
  const started = performance.now();
  const captureBody = { system: SYSTEM, task: 'Solve the attached objective question.',
    image_base64: image, image_media_type: 'image/png' };
  if (protocolEnabled) {
    captureBody.result_protocol = 'objective_v1';
    captureBody.capture_id = crypto.randomUUID();
  }
  const response = await fetch(`${baseURL}/v1/captures`, {
    method: 'POST', headers: { ...evaluationHeaders,
      authorization: `Bearer ${deviceTokens[index % deviceTokens.length]}`,
      'content-type': 'application/json', 'x-app-version': process.env.NSPI_EVAL_APP_VERSION },
    body: JSON.stringify(captureBody),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`fixture ${fixture.id} failed with HTTP ${response.status}`);
  const events = body.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
    try { return [JSON.parse(line.slice(6))]; } catch { return []; }
  });
  const raw = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
  const usage = events.find((event) => event.type === 'usage');
  const streamError = events.find((event) => event.type === 'error');
  if (streamError || !usage) throw new Error(`fixture ${fixture.id} ended without a usage result`);
  const parsed = composeObjectiveResult(raw, protocolEnabled);
  const answerHit = fixture.expected_state === 'retake'
    ? (protocolEnabled ? parsed.state === 'retake' : null)
    : matchesAcceptedAnswer(fixture, parsed.finalAnswer);
  const record = {
    id: fixture.id, language: fixture.language, kind: fixture.kind,
    expected_state: fixture.expected_state,
    schema_valid: protocolEnabled ? parsed.parserPath === 'v1' : null,
    actual_state: protocolEnabled ? parsed.state : null,
    parser_path: parsed.parserPath, answer_hit: answerHit,
    state_match: protocolEnabled ? parsed.state === fixture.expected_state : null,
    normalized_answer: parsed.finalAnswer ? normalizeObjectiveAnswer(parsed.finalAnswer) : null,
    input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
    total_ms: Math.round(performance.now() - started), model: process.env.NSPI_EVAL_MODEL,
    prompt_variant: variant,
    prompt_version: protocolEnabled ? manifest.prompt_version : `legacy-brief-${process.env.NSPI_EVAL_APP_VERSION}`,
    manifest_sha256: manifestSHA256, commit: process.env.NSPI_EVAL_COMMIT,
    app_version: process.env.NSPI_EVAL_APP_VERSION, executor: process.env.NSPI_EVAL_EXECUTOR,
    reviewer: process.env.NSPI_EVAL_REVIEWER,
  };
  records.push(record);
  await appendFile(jsonl, `${JSON.stringify(record)}\n`);
  const resultLabel = answerHit === null ? 'reference-only' : answerHit ? '✓' : '✗';
  console.log(`[${index + 1}/240] ${fixture.id}: ${record.parser_path}/${record.actual_state ?? 'n/a'} ${resultLabel}`);
}

const ratio = (n, d) => d ? n / d : 0;
const answerable = records.filter((r) => r.expected_state !== 'retake');
const predictedReady = records.filter((r) => r.actual_state === 'ready');
const expectedReview = records.filter((r) => r.expected_state === 'review');
const stateAccuracy = (rows) => ratio(rows.filter((r) => r.answer_hit).length, rows.length);
const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const summary = {
  generated_at: new Date().toISOString(), calls: records.length, variant,
  manifest_sha256: manifestSHA256, model: process.env.NSPI_EVAL_MODEL,
  answerable_accuracy: stateAccuracy(answerable),
  by_kind: Object.fromEntries([...new Set(records.map((r) => r.kind))].map((key) => [key, stateAccuracy(answerable.filter((r) => r.kind === key))])),
  by_language: Object.fromEntries([...new Set(records.map((r) => r.language))].map((key) => [key, stateAccuracy(answerable.filter((r) => r.language === key))])),
  avg_tokens: average(records.flatMap((r) => r.input_tokens === null || r.output_tokens === null ? [] : [r.input_tokens + r.output_tokens])),
  p95_total_ms: records.map((r) => r.total_ms).sort((a, b) => a - b)[Math.ceil(records.length * .95) - 1],
};
if (protocolEnabled) {
  summary.v1_valid_rate = ratio(records.filter((r) => r.schema_valid).length, records.length);
  summary.ready_precision = ratio(predictedReady.filter((r) => r.expected_state === 'ready' && r.answer_hit).length,
    predictedReady.length);
  summary.review_recall = ratio(expectedReview.filter((r) => r.actual_state === 'review').length,
    expectedReview.length);
  summary.state_accuracy = ratio(records.filter((r) => r.state_match).length, records.length);
  summary.retake_recall = ratio(records.filter((r) => r.expected_state === 'retake' && r.actual_state === 'retake').length,
    records.filter((r) => r.expected_state === 'retake').length);
}
const failures = [];
if (protocolEnabled) {
  if (summary.v1_valid_rate < .98) failures.push('V1 valid rate < 98%');
  if (summary.answerable_accuracy < .92) failures.push('answerable accuracy < 92%');
  if (summary.ready_precision < .97) failures.push('ready precision < 97%');
  if (summary.retake_recall < .90) failures.push('retake recall < 90%');
  for (const [key, value] of Object.entries(summary.by_kind)) if (value < .85) failures.push(`${key} accuracy < 85%`);
  for (const [key, value] of Object.entries(summary.by_language)) if (value < .85) failures.push(`${key} accuracy < 85%`);
}
const summaryPath = resolve(outputDir, `${outputPrefix}-summary.json`);
await writeFile(summaryPath, `${JSON.stringify({ ...summary, failures }, null, 2)}\n`);
const summaryLines = [`# Objective evaluation — ${variant}`, '', `- Calls: ${records.length}`,
  `- Answerable accuracy: ${(summary.answerable_accuracy * 100).toFixed(2)}%`,
  `- Average tokens: ${summary.avg_tokens?.toFixed(2) ?? 'n/a'}`,
  `- p95 total: ${summary.p95_total_ms} ms`];
if (protocolEnabled) {
  summaryLines.push(`- V1 valid: ${(summary.v1_valid_rate * 100).toFixed(2)}%`,
    `- Ready precision: ${(summary.ready_precision * 100).toFixed(2)}%`,
    `- Retake recall: ${(summary.retake_recall * 100).toFixed(2)}%`);
}
summaryLines.push(`- Gate: ${failures.length ? `FAIL — ${failures.join('; ')}` : 'PASS'}`);
await writeFile(resolve(outputDir, `${outputPrefix}-summary.md`), `${summaryLines.join('\n')}\n`);

const comparisonFailures = [];
if (!protocolEnabled && process.env.NSPI_EVAL_TREATMENT_SUMMARY) {
  if (!process.env.NSPI_EVAL_TREATMENT_JSONL) {
    throw new Error('NSPI_EVAL_TREATMENT_JSONL is required with NSPI_EVAL_TREATMENT_SUMMARY');
  }
  const treatment = JSON.parse(await readFile(resolve(root, process.env.NSPI_EVAL_TREATMENT_SUMMARY), 'utf8'));
  const treatmentRows = (await readFile(resolve(root, process.env.NSPI_EVAL_TREATMENT_JSONL), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  if (treatmentRows.length !== 240) throw new Error('treatment JSONL must contain 240 rows');
  const treatmentModels = new Set(treatmentRows.map((row) => row.model));
  const treatmentCommits = new Set(treatmentRows.map((row) => row.commit));
  if (treatmentModels.size !== 1 || !treatmentModels.has(process.env.NSPI_EVAL_MODEL)) {
    throw new Error('baseline and treatment models differ');
  }
  if (treatmentCommits.size !== 1) throw new Error('treatment JSONL contains multiple commits');
  const treatmentCommit = [...treatmentCommits][0];
  const treatmentManifest = execFileSync('git', ['show', `${treatmentCommit}:Tests/Fixtures/objective-v1/manifest.json`],
    { cwd: root });
  const treatmentManifestSHA256 = createHash('sha256').update(treatmentManifest).digest('hex');
  if (treatmentManifestSHA256 !== manifestSHA256) throw new Error('baseline and treatment manifests differ');
  const accuracyDelta = treatment.answerable_accuracy - summary.answerable_accuracy;
  const tokenIncrease = treatment.avg_tokens / summary.avg_tokens - 1;
  const p95Increase = treatment.p95_total_ms / summary.p95_total_ms - 1;
  if (accuracyDelta < -.01) comparisonFailures.push('answerable accuracy regression > 1 percentage point');
  if (tokenIncrease > .08) comparisonFailures.push('average token increase > 8%');
  if (p95Increase > .10) comparisonFailures.push('p95 latency increase > 10%');
  const comparison = {
    generated_at: new Date().toISOString(), status: 'pending_independent_review',
    manifest_sha256: manifestSHA256, model: process.env.NSPI_EVAL_MODEL,
    baseline: { source: summaryPath.slice(root.length + 1), answerable_accuracy: summary.answerable_accuracy,
      avg_tokens: summary.avg_tokens, p95_total_ms: summary.p95_total_ms },
    treatment: { source: process.env.NSPI_EVAL_TREATMENT_SUMMARY,
      answerable_accuracy: treatment.answerable_accuracy, avg_tokens: treatment.avg_tokens,
      p95_total_ms: treatment.p95_total_ms },
    deltas: { accuracy_percentage_points: accuracyDelta * 100,
      average_tokens_ratio: tokenIncrease, p95_latency_ratio: p95Increase },
    thresholds: { max_accuracy_regression_percentage_points: 1,
      max_average_tokens_ratio: .08, max_p95_latency_ratio: .10 },
    failures: comparisonFailures,
  };
  await writeFile(resolve(outputDir, `${outputPrefix}-comparison.json`), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(resolve(outputDir, `${outputPrefix}-comparison.md`), `# Objective V1 vs fixed legacy baseline\n\n`
    + `- Status: PENDING INDEPENDENT REVIEW\n- Model: ${comparison.model}\n- Manifest: ${manifestSHA256}\n`
    + `- Accuracy: baseline ${(summary.answerable_accuracy * 100).toFixed(2)}% → treatment ${(treatment.answerable_accuracy * 100).toFixed(2)}% (${(accuracyDelta * 100).toFixed(2)} pp)\n`
    + `- Average tokens: baseline ${summary.avg_tokens.toFixed(2)} → treatment ${treatment.avg_tokens.toFixed(2)} (${(tokenIncrease * 100).toFixed(2)}%)\n`
    + `- p95 latency: baseline ${summary.p95_total_ms} ms → treatment ${treatment.p95_total_ms} ms (${(p95Increase * 100).toFixed(2)}%)\n`
    + `- Gate: ${comparisonFailures.length ? `FAIL — ${comparisonFailures.join('; ')}` : 'PASS'}\n`);
}
const terminalFailures = [...failures, ...comparisonFailures];
if (terminalFailures.length) { console.error(terminalFailures.join('\n')); process.exit(1); }
