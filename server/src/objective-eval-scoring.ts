import { normalizeObjectiveAnswer } from './objective-result.ts';

// Alternative results form a set: `A or B` and `B or A` are equivalent, while order inside each
// result remains significant. This is evaluation-only semantics; FINAL-vs-JSON protocol matching
// stays byte-normalized and intentionally strict in the production parser.
function alternatives(answer: string): string[] {
  return normalizeObjectiveAnswer(answer)
    .split(/\s+or\s+|\s*或\s*|または|\s+\/\s+/iu)
    .map((value) => normalizeObjectiveAnswer(value))
    .filter(Boolean)
    .sort();
}

export function objectiveEvalAnswerHit(
  actual: string | null | undefined,
  acceptedAnswers: string[],
): boolean {
  const normalized = normalizeObjectiveAnswer(actual ?? '');
  if (acceptedAnswers.some((answer) => normalizeObjectiveAnswer(answer) === normalized)) return true;
  const actualAlternatives = alternatives(normalized);
  if (actualAlternatives.length < 2) return false;
  return acceptedAnswers.some((answer) => {
    const acceptedAlternatives = alternatives(answer);
    return acceptedAlternatives.length === actualAlternatives.length
      && acceptedAlternatives.every((value, index) => value === actualAlternatives[index]);
  });
}
