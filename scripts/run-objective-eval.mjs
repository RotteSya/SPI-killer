#!/usr/bin/env node
// Explicit, paid release gate. Never runs from normal CI: NSPI_RUN_OBJECTIVE_EVAL=1 is required.
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { composeObjectiveResult, normalizeObjectiveAnswer } from '../server/src/objective-result.ts';
import { objectiveEvalAnswerHit } from '../server/src/objective-eval-scoring.ts';
import { openEvaluationBudget } from './lib/evaluation-budget.mts';
import { openEvaluationAccess } from './lib/evaluation-access.mts';

if (process.env.NSPI_RUN_OBJECTIVE_EVAL !== '1') {
  console.error('Set NSPI_RUN_OBJECTIVE_EVAL=1 to run the paid 240-call release evaluation.');
  process.exit(2);
}
const required = ['NSPI_EVAL_BASE_URL', 'NSPI_EVAL_DEVICE_TOKEN', 'NSPI_EVAL_MODEL',
  'NSPI_EVAL_COMMIT', 'NSPI_EVAL_APP_VERSION', 'NSPI_EVAL_EXECUTOR', 'NSPI_EVAL_REVIEWER'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
if (process.env.NSPI_EVAL_EXECUTOR.trim() === process.env.NSPI_EVAL_REVIEWER.trim()) throw new Error('Release evaluation requires a different independent reviewer');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(root, 'Tests/Fixtures/objective-v1');
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8'));
if (manifest.fixtures.length !== 240) throw new Error('manifest must contain exactly 240 fixtures');
for (const fixture of manifest.fixtures) {
  const image = await readFile(resolve(fixtureRoot, fixture.image));
  const digest = createHash('sha256').update(image).digest('hex');
  if (digest !== fixture.sha256) throw new Error(`fixture ${fixture.id} sha256 mismatch`);
}
const outputDir = resolve(root, 'objective-eval-output');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const jsonl = resolve(outputDir, `${stamp}.jsonl`);
const baseURL = process.env.NSPI_EVAL_BASE_URL.replace(/\/$/, '');
const budget = openEvaluationBudget(root, process.env.NSPI_EVAL_MODEL, baseURL);
process.once('exit', () => budget.close());
console.log('CNY budget preflight:', budget.checkWholeRun(manifest.fixtures.length));

// Preview deployments stay protected. A temporary Vercel share token is exchanged once for the
// HttpOnly deployment cookie, then every evaluation request carries that cookie. Production or
// otherwise-unprotected candidates omit NSPI_EVAL_VERCEL_SHARE_TOKEN and use no extra header.
const evaluationAccess = await openEvaluationAccess(baseURL, process.env.NSPI_EVAL_VERCEL_SHARE_TOKEN);

// Read the prompt from the Swift SSOT rather than maintaining an evaluation-only copy.
const SYSTEM = execFileSync('swift', ['run', 'NotchSPI', '--print-objective-eval-prompt'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const TASK = execFileSync('swift', ['run', 'NotchSPI', '--print-objective-eval-task'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();

const records = [];
for (const [index, fixture] of manifest.fixtures.entries()) {
  const image = (await readFile(resolve(fixtureRoot, fixture.image))).toString('base64');
  const started = performance.now();
  const response = await budget.fetchText('/v1/captures', {
    method: 'POST', headers: { ...evaluationAccess.headersFor(baseURL + '/v1/captures'),
      authorization: `Bearer ${process.env.NSPI_EVAL_DEVICE_TOKEN}`,
      'content-type': 'application/json', 'x-app-version': process.env.NSPI_EVAL_APP_VERSION },
    body: JSON.stringify({ system: SYSTEM, task: TASK,
      image_base64: image, image_media_type: 'image/png', result_protocol: 'objective_v1',
      capture_id: crypto.randomUUID() }),
  }, fixture.id, 'answer');
  const body = response.body;
  if (!response.ok) throw new Error(`fixture ${fixture.id} failed with HTTP ${response.status}`);
  const events = body.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
    try { return [JSON.parse(line.slice(6))]; } catch { return []; }
  });
  const raw = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
  const usage = events.find((event) => event.type === 'usage');
  const streamError = events.find((event) => event.type === 'error');
  budget.observeUsage(response.dispatchId, usage?.input_tokens, usage?.output_tokens);
  if (streamError || !usage) throw new Error(`fixture ${fixture.id} ended without a usage result`);
  const parsed = composeObjectiveResult(raw, true);
  const answerHit = fixture.expected_state === 'retake'
    ? parsed.state === 'retake'
    : objectiveEvalAnswerHit(parsed.finalAnswer, fixture.accepted_answers);
  const record = {
    id: fixture.id, language: fixture.language, kind: fixture.kind,
    expected_state: fixture.expected_state, schema_valid: parsed.parserPath === 'v1',
    actual_state: parsed.state, parser_path: parsed.parserPath, answer_hit: answerHit,
    state_match: parsed.state === fixture.expected_state,
    normalized_answer: parsed.finalAnswer ? normalizeObjectiveAnswer(parsed.finalAnswer) : null,
    input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
    total_ms: Math.round(performance.now() - started), model: process.env.NSPI_EVAL_MODEL,
    prompt_version: manifest.prompt_version, commit: process.env.NSPI_EVAL_COMMIT,
    app_version: process.env.NSPI_EVAL_APP_VERSION, executor: process.env.NSPI_EVAL_EXECUTOR,
    reviewer: process.env.NSPI_EVAL_REVIEWER,
    budget_dispatch_id: response.dispatchId, budget_upper_cny_micros: response.upperCNYMicros,
  };
  records.push(record);
  await appendFile(jsonl, `${JSON.stringify(record)}\n`);
  console.log(`[${index + 1}/240] ${fixture.id}: ${record.parser_path}/${record.actual_state} ${answerHit ? '✓' : '✗'}`);
}

const ratio = (n, d) => d ? n / d : 0;
const answerable = records.filter((r) => r.expected_state !== 'retake');
const predictedReady = records.filter((r) => r.actual_state === 'ready');
const expectedReview = records.filter((r) => r.expected_state === 'review');
const stateAccuracy = (rows) => ratio(rows.filter((r) => r.answer_hit).length, rows.length);
const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const summary = {
  generated_at: new Date().toISOString(), calls: records.length,
  v1_valid_rate: ratio(records.filter((r) => r.schema_valid).length, records.length),
  answerable_accuracy: stateAccuracy(answerable),
  ready_precision: ratio(predictedReady.filter((r) => r.expected_state === 'ready' && r.answer_hit).length,
    predictedReady.length),
  review_recall: ratio(expectedReview.filter((r) => r.actual_state === 'review').length,
    expectedReview.length),
  state_accuracy: ratio(records.filter((r) => r.state_match).length, records.length),
  retake_recall: ratio(records.filter((r) => r.expected_state === 'retake' && r.actual_state === 'retake').length,
    records.filter((r) => r.expected_state === 'retake').length),
  by_kind: Object.fromEntries([...new Set(records.map((r) => r.kind))].map((key) => [key, stateAccuracy(answerable.filter((r) => r.kind === key))])),
  by_language: Object.fromEntries([...new Set(records.map((r) => r.language))].map((key) => [key, stateAccuracy(answerable.filter((r) => r.language === key))])),
  avg_tokens: average(records.flatMap((r) => r.input_tokens === null || r.output_tokens === null ? [] : [r.input_tokens + r.output_tokens])),
  p95_total_ms: records.map((r) => r.total_ms).sort((a, b) => a - b)[Math.ceil(records.length * .95) - 1],
};
const failures = [];
if (summary.v1_valid_rate < .98) failures.push('V1 valid rate < 98%');
if (summary.answerable_accuracy < .92) failures.push('answerable accuracy < 92%');
if (summary.ready_precision < .97) failures.push('ready precision < 97%');
if (summary.retake_recall < .90) failures.push('retake recall < 90%');
for (const [key, value] of Object.entries(summary.by_kind)) if (value < .85) failures.push(`${key} accuracy < 85%`);
for (const [key, value] of Object.entries(summary.by_language)) if (value < .85) failures.push(`${key} accuracy < 85%`);
await writeFile(resolve(outputDir, `${stamp}-summary.json`), `${JSON.stringify({ ...summary, failures }, null, 2)}\n`);
await writeFile(resolve(outputDir, `${stamp}-summary.md`), `# Objective V1 evaluation\n\n- Calls: ${records.length}\n- V1 valid: ${(summary.v1_valid_rate * 100).toFixed(2)}%\n- Answerable accuracy: ${(summary.answerable_accuracy * 100).toFixed(2)}%\n- Ready precision: ${(summary.ready_precision * 100).toFixed(2)}%\n- Retake recall: ${(summary.retake_recall * 100).toFixed(2)}%\n- Gate: ${failures.length ? `FAIL — ${failures.join('; ')}` : 'PASS'}\n`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
