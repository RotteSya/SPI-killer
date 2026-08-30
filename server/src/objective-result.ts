export const OBJECTIVE_RESULT_MARKER = 'NSPI_RESULT_V1:';

export type ObjectiveQuestionKind =
  | 'single_choice' | 'multiple_choice' | 'ordering' | 'short_fill' | 'other';
export type ObjectiveResultState = 'ready' | 'review' | 'retake';
export type ObjectiveResultReason =
  | 'none' | 'ambiguous_question' | 'ambiguous_options' | 'cropped' | 'unreadable'
  | 'missing_context' | 'unsupported';
export type ObjectiveParserPath = 'v1' | 'legacy_fallback' | 'legacy' | 'none';
export type ObjectiveProtocolViolation =
  | 'duplicateMarker' | 'markerNotLast' | 'invalidJSON' | 'oversizedJSON' | 'unknownField'
  | 'invalidEnum' | 'invalidStateCombination' | 'finalMismatch' | 'missingUsableResult';

export interface ObjectiveResultV1 {
  v: 1;
  kind: ObjectiveQuestionKind;
  state: ObjectiveResultState;
  answer: string | null;
  reason: ObjectiveResultReason;
}

export interface ObjectiveResultComposition {
  visibleText: string;
  finalAnswer: string | null;
  result: ObjectiveResultV1 | null;
  state: ObjectiveResultState | null;
  parserPath: ObjectiveParserPath;
  violations: ObjectiveProtocolViolation[];
}

const KINDS = new Set<ObjectiveQuestionKind>([
  'single_choice', 'multiple_choice', 'ordering', 'short_fill', 'other',
]);
const STATES = new Set<ObjectiveResultState>(['ready', 'review', 'retake']);
const REASONS = new Set<ObjectiveResultReason>([
  'none', 'ambiguous_question', 'ambiguous_options', 'cropped', 'unreadable',
  'missing_context', 'unsupported',
]);
const KEYS = ['answer', 'kind', 'reason', 'state', 'v'];
const OBJECTIVE_KINDS = new Set<ObjectiveQuestionKind>([
  'single_choice', 'multiple_choice', 'ordering', 'short_fill',
]);

function pushUnique(out: ObjectiveProtocolViolation[], value: ObjectiveProtocolViolation): void {
  if (!out.includes(value)) out.push(value);
}

function markerIsInsideMarkdownFence(lines: string[], markerIndex: number): boolean {
  let fence: '```' | '~~~' | null = null;
  for (const line of lines.slice(0, markerIndex)) {
    const match = /^\s*(```|~~~)/u.exec(line);
    if (!match) continue;
    const token = match[1] as '```' | '~~~';
    if (fence === null) fence = token;
    else if (fence === token) fence = null;
  }
  return fence !== null;
}

/** Shared FINAL/answer canonicalization. JS normalize('NFKC') is Unicode NFKC. */
export function normalizeObjectiveAnswer(value: string): string {
  let out = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of [['**', '**'], ['__', '__'], ['`', '`']] as const) {
      if (out.startsWith(pair[0]) && out.endsWith(pair[1]) && out.length > pair[0].length + pair[1].length) {
        out = out.slice(pair[0].length, -pair[1].length).trim();
        changed = true;
      }
    }
  }
  return /^[a-z]$/i.test(out) ? out.toUpperCase() : out;
}

export function extractFinalAnswer(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const match = /^[ \t]{0,3}(?:#{1,6}[ \t]*)?(?:\*{1,2}|_{1,2})?[ \t]*FINAL[ \t]*[:：][ \t]*(.+)$/iu.exec(line);
    if (!match) continue;
    let answer = match[1]!.trim();
    for (const fence of ['**', '__']) {
      const count = answer.split(fence).length - 1;
      if (count % 2 === 1) {
        if (answer.startsWith(fence)) answer = answer.slice(fence.length).trim();
        else if (answer.endsWith(fence)) answer = answer.slice(0, -fence.length).trim();
      }
    }
    return answer.length > 0 && [...answer].length <= 512 ? answer : null;
  }
  return null;
}

function validateObject(raw: unknown, violations: ObjectiveProtocolViolation[]): ObjectiveResultV1 | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    pushUnique(violations, 'invalidJSON');
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i])) {
    pushUnique(violations, 'unknownField');
    return null;
  }
  if (obj.v !== 1 || typeof obj.kind !== 'string' || !KINDS.has(obj.kind as ObjectiveQuestionKind)
      || typeof obj.state !== 'string' || !STATES.has(obj.state as ObjectiveResultState)
      || typeof obj.reason !== 'string' || !REASONS.has(obj.reason as ObjectiveResultReason)) {
    pushUnique(violations, 'invalidEnum');
    return null;
  }
  const result = obj as unknown as ObjectiveResultV1;
  const answerLength = typeof result.answer === 'string' ? [...result.answer].length : 0;
  let valid = true;
  if (result.state === 'ready') {
    valid = typeof result.answer === 'string' && answerLength >= 1 && answerLength <= 512
      && result.reason === 'none' && OBJECTIVE_KINDS.has(result.kind);
  } else if (result.state === 'review') {
    valid = typeof result.answer === 'string' && answerLength >= 1 && answerLength <= 512
      && ['ambiguous_question', 'ambiguous_options', 'missing_context', 'unsupported'].includes(result.reason)
      && (result.kind !== 'other' || result.reason === 'unsupported');
  } else {
    valid = result.answer === null && ['cropped', 'unreadable', 'missing_context'].includes(result.reason);
  }
  if (!valid) {
    pushUnique(violations, 'invalidStateCombination');
    return null;
  }
  return result;
}

/** Strict completion-time parser. `protocolEnabled=false` preserves legacy FINAL behavior. */
export function composeObjectiveResult(text: string, protocolEnabled = true): ObjectiveResultComposition {
  const normalizedText = text.replace(/\r\n?/g, '\n');
  const lines = normalizedText.split('\n');
  const markerIndexes = lines.flatMap((line, index) => line.startsWith(OBJECTIVE_RESULT_MARKER) ? [index] : []);
  const violations: ObjectiveProtocolViolation[] = [];
  if (markerIndexes.length > 1) pushUnique(violations, 'duplicateMarker');
  const nonEmptyLast = lines.findLastIndex((line) => line.trim() !== '');
  if (markerIndexes.length > 0 && markerIndexes.at(-1) !== nonEmptyLast) pushUnique(violations, 'markerNotLast');

  const visibleText = lines
    .filter((line) => !line.startsWith(OBJECTIVE_RESULT_MARKER))
    .join('\n')
    .replace(/\s+$/u, '');
  const finalAnswer = extractFinalAnswer(visibleText);
  let result: ObjectiveResultV1 | null = null;

  const markerInFence = markerIndexes.length === 1
    && markerIsInsideMarkdownFence(lines, markerIndexes[0]!);
  if (markerInFence) pushUnique(violations, 'invalidStateCombination');

  if (protocolEnabled && markerIndexes.length === 1 && markerIndexes[0] === nonEmptyLast && !markerInFence) {
    const payload = lines[markerIndexes[0]!]!.slice(OBJECTIVE_RESULT_MARKER.length).trimStart();
    if (Buffer.byteLength(payload, 'utf8') > 4096) {
      pushUnique(violations, 'oversizedJSON');
    } else {
      try {
        result = validateObject(JSON.parse(payload) as unknown, violations);
      } catch {
        pushUnique(violations, 'invalidJSON');
      }
    }
    if (result && result.state !== 'retake') {
      if (!finalAnswer || normalizeObjectiveAnswer(finalAnswer) !== normalizeObjectiveAnswer(result.answer ?? '')) {
        pushUnique(violations, 'finalMismatch');
        result = null;
      }
    } else if (result?.state === 'retake' && finalAnswer !== null) {
      pushUnique(violations, 'invalidStateCombination');
      result = null;
    }
  }

  if (result) {
    return { visibleText, finalAnswer: result.answer, result, state: result.state, parserPath: 'v1', violations };
  }
  if (finalAnswer) {
    return {
      visibleText, finalAnswer, result: null,
      state: protocolEnabled ? 'review' : null,
      parserPath: protocolEnabled ? 'legacy_fallback' : 'legacy', violations,
    };
  }
  pushUnique(violations, 'missingUsableResult');
  return { visibleText, finalAnswer: null, result: null, state: null, parserPath: 'none', violations };
}

export function objectiveResultIsBillable(composition: ObjectiveResultComposition): boolean {
  return composition.parserPath === 'legacy_fallback'
    || (composition.parserPath === 'v1' && composition.state !== 'retake');
}
