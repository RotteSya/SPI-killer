import { normalizeObjectiveAnswer } from '../server/src/objective-result.ts';

function optionLetters(value) {
  const normalized = value.normalize('NFKC');
  return [...normalized.matchAll(/(^|[^A-Za-z])([A-D])(?=$|[^A-Za-z])/gu)]
    .map((match) => match[2]);
}

export function matchesAcceptedAnswer(fixture, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false;
  const normalizedCandidate = normalizeObjectiveAnswer(candidate);
  if (fixture.accepted_answers.some((answer) =>
    normalizeObjectiveAnswer(answer) === normalizedCandidate)) return true;

  if (fixture.kind !== 'multiple_choice' && fixture.kind !== 'ordering') return false;
  const candidateLetters = optionLetters(normalizedCandidate);
  if (candidateLetters.length < 2) return false;
  const candidateSignature = fixture.kind === 'multiple_choice'
    ? [...new Set(candidateLetters)].sort().join('') : candidateLetters.join('');
  return fixture.accepted_answers.some((answer) => {
    const letters = optionLetters(normalizeObjectiveAnswer(answer));
    if (letters.length < 2) return false;
    const signature = fixture.kind === 'multiple_choice'
      ? [...new Set(letters)].sort().join('') : letters.join('');
    return signature === candidateSignature;
  });
}

export function summarizeAnswerable(records, fixtures) {
  const fixtureByID = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const rescored = records.map((record) => {
    const fixture = fixtureByID.get(record.id);
    if (!fixture) throw new Error(`record ${record.id} is absent from manifest`);
    const semanticHit = fixture.expected_state === 'retake'
      ? null : matchesAcceptedAnswer(fixture, record.normalized_answer);
    return { ...record, semantic_answer_hit: semanticHit };
  });
  const answerable = rescored.filter((record) => record.expected_state !== 'retake');
  const ratio = (rows) => rows.length === 0 ? 0
    : rows.filter((record) => record.semantic_answer_hit).length / rows.length;
  const average = (values) => values.length === 0 ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  const totalTimes = rescored.map((record) => record.total_ms).sort((a, b) => a - b);
  return {
    records: rescored,
    answerable_accuracy: ratio(answerable),
    by_kind: Object.fromEntries([...new Set(answerable.map((record) => record.kind))]
      .map((kind) => [kind, ratio(answerable.filter((record) => record.kind === kind))])),
    by_language: Object.fromEntries([...new Set(answerable.map((record) => record.language))]
      .map((language) => [language, ratio(answerable.filter((record) => record.language === language))])),
    avg_tokens: average(rescored.flatMap((record) =>
      record.input_tokens === null || record.output_tokens === null
        ? [] : [record.input_tokens + record.output_tokens])),
    p95_total_ms: totalTimes[Math.ceil(totalTimes.length * .95) - 1],
  };
}
