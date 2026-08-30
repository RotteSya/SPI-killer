import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  composeObjectiveResult, normalizeObjectiveAnswer, objectiveResultIsBillable,
} from '../src/objective-result.ts';

const line = (body: object) => `NSPI_RESULT_V1: ${JSON.stringify(body)}`;

test('shared Swift/Node golden fixtures agree with the Node parser', () => {
  const fixtures = JSON.parse(readFileSync(
    new URL('../../Tests/Fixtures/objective-result-v1/cases.json', import.meta.url), 'utf8',
  )) as Array<{ id: string; raw: string; path: string; state: string | null; violations: string[] }>;
  assert.ok(fixtures.length >= 12);
  for (const fixture of fixtures) {
    const parsed = composeObjectiveResult(fixture.raw);
    assert.equal(parsed.parserPath, fixture.path, fixture.id);
    assert.equal(parsed.state, fixture.state, fixture.id);
    for (const violation of fixture.violations) assert.ok(parsed.violations.includes(violation as never), fixture.id);
  }
});

test('valid ready/review are billable and marker is hidden', () => {
  for (const state of ['ready', 'review'] as const) {
    const reason = state === 'ready' ? 'none' : 'ambiguous_options';
    const parsed = composeObjectiveResult(`work\nFINAL: **b**\n${line({
      v: 1, kind: 'single_choice', state, answer: 'B', reason,
    })}`);
    assert.equal(parsed.parserPath, 'v1');
    assert.equal(parsed.state, state);
    assert.equal(parsed.visibleText.includes('NSPI_RESULT'), false);
    assert.equal(objectiveResultIsBillable(parsed), true);
  }
});

test('valid retake is not billable', () => {
  const parsed = composeObjectiveResult(line({
    v: 1, kind: 'single_choice', state: 'retake', answer: null, reason: 'cropped',
  }));
  assert.equal(parsed.parserPath, 'v1');
  assert.equal(parsed.state, 'retake');
  assert.equal(objectiveResultIsBillable(parsed), false);
});

test('invalid V1 with usable FINAL becomes legacy fallback', () => {
  const parsed = composeObjectiveResult(`FINAL: A\n${line({
    v: 1, kind: 'single_choice', state: 'ready', answer: 'B', reason: 'none',
  })}`);
  assert.equal(parsed.parserPath, 'legacy_fallback');
  assert.ok(parsed.violations.includes('finalMismatch'));
  assert.equal(objectiveResultIsBillable(parsed), true);
});

test('strict marker placement, cardinality and exact keys', () => {
  const valid = line({ v: 1, kind: 'single_choice', state: 'ready', answer: 'A', reason: 'none' });
  const duplicate = composeObjectiveResult(`FINAL: A\n${valid}\n${valid}`);
  assert.equal(duplicate.parserPath, 'legacy_fallback');
  assert.ok(duplicate.violations.includes('duplicateMarker'));
  const extra = composeObjectiveResult(`FINAL: A\n${line({
    v: 1, kind: 'single_choice', state: 'ready', answer: 'A', reason: 'none', extra: 1,
  })}`);
  assert.ok(extra.violations.includes('unknownField'));
  const notLast = composeObjectiveResult(`FINAL: A\n${valid}\nafter`);
  assert.ok(notLast.violations.includes('markerNotLast'));
});

test('normalization is NFKC, whitespace/fence tolerant and option-case stable', () => {
  assert.equal(normalizeObjectiveAnswer(' **ｂ** '), 'B');
  assert.equal(normalizeObjectiveAnswer('`foo   bar`'), 'foo bar');
});

test('oversized JSON and missing usable result are rejected', () => {
  const parsed = composeObjectiveResult(`NSPI_RESULT_V1: ${'x'.repeat(4097)}`);
  assert.equal(parsed.parserPath, 'none');
  assert.ok(parsed.violations.includes('oversizedJSON'));
  assert.ok(parsed.violations.includes('missingUsableResult'));
});
