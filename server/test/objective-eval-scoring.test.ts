import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesAcceptedAnswer } from '../../scripts/objective-eval-scoring.mjs';

test('semantic evaluation accepts hybrid option/value formatting for multiple choice', () => {
  const fixture = {
    kind: 'multiple_choice',
    accepted_answers: ['A, C', '2, 5'],
  };
  assert.equal(matchesAcceptedAnswer(fixture, 'A and C (2, 5)'), true);
  assert.equal(matchesAcceptedAnswer(fixture, 'C、A（5、2）'), true);
  assert.equal(matchesAcceptedAnswer(fixture, 'A and D (2, 7)'), false);
});

test('semantic evaluation preserves order for ordering questions', () => {
  const fixture = {
    kind: 'ordering',
    accepted_answers: ['B-D-A-C', '2, 3, 5, 7'],
  };
  assert.equal(matchesAcceptedAnswer(fixture, 'B → D → A → C (2, 3, 5, 7)'), true);
  assert.equal(matchesAcceptedAnswer(fixture, 'B → A → D → C'), false);
});
