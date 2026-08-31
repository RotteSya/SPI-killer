#!/usr/bin/env node
// Paid prompt-development loop. This is deliberately separate from the immutable 240-call gate:
// diagnostic reruns may guide a later prompt revision but can never replace a formal score.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeObjectiveResult, normalizeObjectiveAnswer } from '../server/src/objective-result.ts';
import { objectiveEvalAnswerHit } from '../server/src/objective-eval-scoring.ts';

if (process.env.NSPI_RUN_OBJECTIVE_DIAGNOSTIC !== '1') {
  console.error('Set NSPI_RUN_OBJECTIVE_DIAGNOSTIC=1 to run the paid diagnostic.');
  process.exit(2);
}
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(root, 'Tests/Fixtures/objective-v1');
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8'));
const requestedIDs = new Set((process.env.NSPI_DIAGNOSTIC_IDS ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean));
// Five positions per language/kind cover a normal control, all review variants, and the blurred
// retake case that produced most protocol failures in the first formal run.
const defaultSuffixes = new Set(['02', '15', '16', '17', '19']);
const fixtures = manifest.fixtures.filter((fixture) => requestedIDs.size > 0
  ? requestedIDs.has(fixture.id)
  : defaultSuffixes.has(fixture.id.slice(-2)));
if (fixtures.length === 0) throw new Error('No diagnostic fixtures selected');

for (const fixture of fixtures) {
  const image = await readFile(resolve(fixtureRoot, fixture.image));
  const digest = createHash('sha256').update(image).digest('hex');
  if (digest !== fixture.sha256) throw new Error(`fixture ${fixture.id} sha256 mismatch`);
}

const system = execFileSync('swift', ['run', 'NotchSPI', '--print-objective-eval-prompt'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const task = execFileSync('swift', ['run', 'NotchSPI', '--print-objective-eval-task'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const model = process.env.NSPI_EVAL_MODEL ?? 'deepseek-v4-flash-vision-exp';
const endpoint = `${(process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/u, '')}/chat/completions`;
const outputDir = resolve(root, 'objective-eval-output', 'diagnostics');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const jsonl = resolve(outputDir, `${stamp}.jsonl`);
const records = [];

for (const [index, fixture] of fixtures.entries()) {
  const image = (await readFile(resolve(fixtureRoot, fixture.image))).toString('base64');
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 2048, temperature: 0, stream: true, stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: task },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
        ] },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`fixture ${fixture.id} failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
  const chunks = body.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
    try { return [JSON.parse(line.slice(6))]; } catch { return []; }
  });
  const vendorError = chunks.find((chunk) => chunk.error)?.error;
  if (vendorError) throw new Error(`fixture ${fixture.id}: ${vendorError.message ?? 'stream error'}`);
  const raw = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');
  const usage = chunks.findLast((chunk) => chunk.usage)?.usage;
  const parsed = composeObjectiveResult(raw, true);
  const answerHit = fixture.expected_state === 'retake'
    ? parsed.state === 'retake'
    : objectiveEvalAnswerHit(parsed.finalAnswer, fixture.accepted_answers);
  const record = {
    id: fixture.id, language: fixture.language, kind: fixture.kind,
    expected_state: fixture.expected_state, actual_state: parsed.state,
    parser_path: parsed.parserPath, schema_valid: parsed.parserPath === 'v1',
    answer_hit: answerHit, state_match: parsed.state === fixture.expected_state,
    normalized_answer: parsed.finalAnswer ? normalizeObjectiveAnswer(parsed.finalAnswer) : null,
    violations: parsed.violations, input_tokens: usage?.prompt_tokens ?? null,
    output_tokens: usage?.completion_tokens ?? null,
    total_ms: Math.round(performance.now() - started), raw,
  };
  records.push(record);
  await appendFile(jsonl, `${JSON.stringify(record)}\n`);
  console.log(`[${index + 1}/${fixtures.length}] ${fixture.id}: ${record.parser_path}/${record.actual_state} ${answerHit ? '✓' : '✗'}`);
}

const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const answerable = records.filter((record) => record.expected_state !== 'retake');
const expectedReview = records.filter((record) => record.expected_state === 'review');
const predictedReady = records.filter((record) => record.actual_state === 'ready');
const retakes = records.filter((record) => record.expected_state === 'retake');
const summary = {
  generated_at: new Date().toISOString(), calls: records.length, model,
  prompt_bytes: Buffer.byteLength(system),
  v1_valid_rate: ratio(records.filter((record) => record.schema_valid).length, records.length),
  answerable_accuracy: ratio(answerable.filter((record) => record.answer_hit).length, answerable.length),
  ready_precision: ratio(predictedReady.filter((record) => record.expected_state === 'ready' && record.answer_hit).length,
    predictedReady.length),
  review_recall: ratio(expectedReview.filter((record) => record.actual_state === 'review').length,
    expectedReview.length),
  retake_recall: ratio(retakes.filter((record) => record.actual_state === 'retake').length, retakes.length),
  avg_tokens: average(records.flatMap((record) => record.input_tokens === null || record.output_tokens === null
    ? [] : [record.input_tokens + record.output_tokens])),
  avg_total_ms: average(records.map((record) => record.total_ms)),
  failures: records.filter((record) => !record.schema_valid || !record.answer_hit || !record.state_match)
    .map((record) => record.id),
};
await writeFile(resolve(outputDir, `${stamp}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
