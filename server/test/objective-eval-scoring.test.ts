import assert from 'node:assert/strict';
import test from 'node:test';
import { objectiveEvalAnswerHit } from '../src/objective-eval-scoring.ts';

test('objective evaluation treats alternative results as an unordered set', () => {
  assert.equal(objectiveEvalAnswerHit('D-B-A-C or B-D-A-C', ['B-D-A-C or D-B-A-C']), true);
  assert.equal(objectiveEvalAnswerHit('D-B-A-C 或 B-D-A-C', ['B-D-A-C or D-B-A-C']), true);
  assert.equal(objectiveEvalAnswerHit('D-B-A-CまたはB-D-A-C', ['B-D-A-C or D-B-A-C']), true);
});

test('objective evaluation remains strict within each result and for multi-select answers', () => {
  assert.equal(objectiveEvalAnswerHit('B-D-C-A or D-C-B-A', ['B-D-C-A or D-B-C-A']), false);
  assert.equal(objectiveEvalAnswerHit('B-D-C-A', ['B-D-C-A or D-B-C-A']), false);
  assert.equal(objectiveEvalAnswerHit('113 or 109', ['113, 109']), false);
});
