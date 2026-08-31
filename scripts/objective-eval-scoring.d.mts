export interface ObjectiveEvalFixture {
  id?: string;
  kind: string;
  expected_state?: string;
  accepted_answers: string[];
}

export interface ObjectiveEvalRecord {
  id: string;
  expected_state: string;
  kind: string;
  language: string;
  normalized_answer: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_ms: number;
  [key: string]: unknown;
}

export function matchesAcceptedAnswer(
  fixture: ObjectiveEvalFixture,
  candidate: string | null | undefined,
): boolean;

export function summarizeAnswerable(
  records: ObjectiveEvalRecord[],
  fixtures: ObjectiveEvalFixture[],
): {
  records: Array<ObjectiveEvalRecord & { semantic_answer_hit: boolean | null }>;
  answerable_accuracy: number;
  by_kind: Record<string, number>;
  by_language: Record<string, number>;
  avg_tokens: number | null;
  p95_total_ms: number;
};
