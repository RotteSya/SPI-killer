import type {
  ProductEventInput, ProductMetrics, ProductMetricsQuery, StoredProductEvent, StoredUsageMetric,
} from './db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_NAMES = new Set(['capture_started', 'capture_completed', 'answer_action', 'auto_session_started', 'auto_session_ended']);
const TRIGGERS = new Set(['capture_hotkey', 'context_hotkey', 'personality_hotkey', 'auto', 'qa']);
const CHANNELS = new Set(['official', 'custom_key', 'cli']);
const MODES = new Set(['tutor', 'personality']);
const DEPTHS = new Set(['brief', 'hint', 'guided', 'full']);
const KINDS = new Set(['single_choice', 'multiple_choice', 'ordering', 'short_fill', 'other']);
const STATES = new Set(['ready', 'review', 'retake']);
const PATHS = new Set(['v1', 'legacy_fallback', 'legacy', 'none']);
const ACTIONS = new Set(['copy', 'reveal_reasoning', 'retry', 'show_explanation', 'add_context', 'remove_context', 'start_new_session', 'select_region', 'confirm_review', 'recover_answer', 'export_feedback']);
const ERROR_CODES = new Set(['protocol_invalid','invalid_scope','multiple_targets','unsupported_scope','no_usable_result','feature_disabled','budget_exceeded','upstream_error','internal','transport_error','blank_capture','capture_failed','watchdog_timeout','user_toggled','capture_hotkey','stop_button','question_cap','quota_exhausted','run_failed','idle_timeout','hash_failures']);
const VARIANTS = new Set(['control','objective_v1']);
const EVENT_KEYS = new Set([
  'event_id', 'capture_id', 'occurred_at', 'event_name', 'trigger', 'channel', 'mode', 'depth',
  'context_count', 'question_kind', 'result_state', 'parser_path', 'error_code', 'action',
  'capture_ms', 'first_token_ms', 'total_ms', 'config_revision', 'variant',
  'profile_id', 'profile_version', 'source_group', 'source_method', 'usable_result', 'completion_kind',
  'operation', 'session_id', 'consent_epoch', 'queue_drop_count',
  'event_sequence',
]);

function nullableString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function enumValue(value: unknown, allowed: Set<string>): string | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function boundedInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value : undefined;
}

export function validateProductEvent(
  raw: unknown, appVersion: string | null, now = new Date(), schemaVersion = 1,
): ProductEventInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !EVENT_KEYS.has(key))) return null;
  if (typeof input.event_id !== 'string' || !UUID.test(input.event_id)) return null;
  if (typeof input.occurred_at !== 'string') return null;
  const occurred = Date.parse(input.occurred_at);
  if (!Number.isFinite(occurred) || (occurred < now.getTime() - 7 * 86_400_000 || occurred > now.getTime() + 300_000)) return null;
  if (typeof input.event_name !== 'string' || !EVENT_NAMES.has(input.event_name)) return null;

  const capture = nullableString(input.capture_id, 36);
  if (capture !== undefined && capture !== null && !UUID.test(capture)) return null;
  const trigger = enumValue(input.trigger, TRIGGERS);
  const channel = enumValue(input.channel, CHANNELS);
  const mode = enumValue(input.mode, MODES);
  const depth = enumValue(input.depth, DEPTHS);
  const contextCount = boundedInt(input.context_count, 0, 4);
  const kind = enumValue(input.question_kind, KINDS);
  const state = enumValue(input.result_state, STATES);
  const parserPath = enumValue(input.parser_path, PATHS);
  const action = enumValue(input.action, ACTIONS);
  const errorCode = enumValue(input.error_code, ERROR_CODES);
  const captureMs = boundedInt(input.capture_ms, 0, 600_000);
  const firstTokenMs = boundedInt(input.first_token_ms, 0, 600_000);
  const totalMs = boundedInt(input.total_ms, 0, 600_000);
  const revision = nullableString(input.config_revision, 64);
  const variant = enumValue(input.variant, VARIANTS);
  const optionalChecks: Array<[string, unknown]> = [
    ['capture_id', capture], ['trigger', trigger], ['channel', channel], ['mode', mode],
    ['depth', depth], ['context_count', contextCount], ['question_kind', kind],
    ['result_state', state], ['parser_path', parserPath], ['action', action],
    ['error_code', errorCode], ['capture_ms', captureMs], ['first_token_ms', firstTokenMs],
    ['total_ms', totalMs], ['config_revision', revision], ['variant', variant],
  ];
  if (optionalChecks.some(([key, value]) => key in input && value === undefined)) return null;

  const fields: Record<string, unknown> = {};
  const extraEnums: Record<string, string[]> = {
    profile_id: ['spi', 'reading_practice', 'general'], profile_version: ['screen-query-v1-r1'],
    source_group: ['spi_entry', 'reading_practice_entry', 'direct', 'unknown'],
    source_method: ['self_reported', 'attributed', 'unknown'],
    completion_kind: ['usable', 'retake', 'no_result', 'failed', 'canceled'], operation: ['solve', 'explain', 'recover'],
  };
  for (const [key, values] of Object.entries(extraEnums)) {
    if (key in input) { if (typeof input[key] !== 'string' || !values.includes(input[key])) return null; fields[key] = input[key]; }
  }
  if ('usable_result' in input) { if (typeof input.usable_result !== 'boolean') return null; fields.usable_result = input.usable_result; }
  if ('session_id' in input) { if (typeof input.session_id !== 'string' || !UUID.test(input.session_id)) return null; fields.session_id = input.session_id.toLowerCase(); }
  for (const key of ['consent_epoch', 'queue_drop_count', 'event_sequence']) {
    if (key in input) { const value=boundedInt(input[key],0,1_000_000_000); if(value===undefined||value===null)return null; fields[key]=value; }
  }
  if(schemaVersion===2) {
    if(typeof fields.consent_epoch!=='number'||typeof fields.event_sequence!=='number')return null;
    if(input.event_name==='capture_completed'&&(!capture||typeof fields.usable_result!=='boolean'||!fields.completion_kind||!fields.operation))return null;
    if(fields.usable_result===true&&(fields.completion_kind!=='usable'||fields.operation!=='solve'||mode!=='tutor'||depth==='hint'||errorCode!=null||
      !((parserPath==='v1'&&(state==='ready'||state==='review'))||parserPath==='legacy_fallback')))return null;
    fields.schema_version=2;
  }
  return {
    extensions: Object.keys(fields).length ? fields : undefined,
    eventId: input.event_id.toLowerCase(),
    captureId: capture?.toLowerCase() ?? null,
    occurredAt: new Date(occurred).toISOString(),
    eventName: input.event_name,
    trigger: trigger ?? null,
    channel: channel ?? null,
    mode: mode ?? null,
    depth: depth ?? null,
    contextCount: contextCount ?? null,
    questionKind: kind ?? null,
    resultState: state ?? null,
    parserPath: parserPath ?? null,
    errorCode: errorCode ?? null,
    action: action ?? null,
    captureMs: captureMs ?? null,
    firstTokenMs: firstTokenMs ?? null,
    totalMs: totalMs ?? null,
    appVersion,
    configRevision: revision ?? null,
    variant: variant ?? null,
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

/** Store-independent aggregation keeps Postgres, SQLite, and memory metric semantics identical. */
export function aggregateProductMetrics(
  rows: StoredProductEvent[], query: ProductMetricsQuery, usageRows: StoredUsageMetric[] = [],
): ProductMetrics {
  const captureOwners=new Map<string,Set<number>>();
  for(const row of rows)if(row.captureId){const key=row.captureId.toLowerCase(),owners=captureOwners.get(key)??new Set<number>();owners.add(row.deviceId);captureOwners.set(key,owners);}
  const groups = new Map<string, StoredProductEvent[]>();
  for (const row of rows) {
    const variant = row.variant ?? 'control';
    if (query.variant && variant !== query.variant) continue;
    const group = groups.get(variant) ?? [];
    group.push(row);
    groups.set(variant, group);
  }
  const variants = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([variant, events]) => {
    const unique = (name: string) => [...new Map(events.filter(e => e.eventName === name)
      .map(e => [e.captureId ? e.deviceId + ':' + e.captureId.toLowerCase() : e.eventId.toLowerCase(), e])).values()];
    const started = unique('capture_started');
    const completed = unique('capture_completed');
    const successful = completed.filter(usableProductResult);
    // An objective-v1 treatment completion with parserPath=none is a protocol failure, not a
    // missing observation. Control has no V1 denominator; mixed/custom queries retain the older
    // path-based denominator so legacy traffic cannot depress the treatment metric.
    const protocol = variant === 'objective_v1'
      ? completed
      : completed.filter((e) => e.parserPath === 'v1' || e.parserPath === 'legacy_fallback');
    const inc = (target: Record<string, number>, key: string | null): void => {
      if (key) target[key] = (target[key] ?? 0) + 1;
    };
    const resultStates: Record<string, number> = {};
    const depths: Record<string, number> = {};
    const actions: Record<string, number> = {};
    completed.forEach((e) => inc(resultStates, e.resultState));
    started.forEach((e) => inc(depths, e.depth));
    events.filter((e) => e.eventName === 'answer_action').forEach((e) => inc(actions, e.action));
    const latency = completed.flatMap((e) => e.totalMs === null ? [] : [e.totalMs]);
    const valid = protocol.filter((e) => e.parserPath === 'v1').length;
    const fallback = protocol.filter((e) => e.parserPath === 'legacy_fallback').length;
    const captureVariants = new Map(events.flatMap((event) => event.captureId
      ? [[event.deviceId+':'+event.captureId.toLowerCase(), event.variant ?? 'control'] as const] : []));
    const usage = usageRows.filter(row=>{
      if(!row.captureId)return variant==='control';
      const id=row.captureId.toLowerCase(),owners=captureOwners.get(id);
      const device=row.deviceId??(owners?.size===1?[...owners][0]:undefined);
      return device!==undefined&&captureVariants.get(device+':'+id)===variant;
    });
    const charged = usage.filter((row) => row.questions > 0);
    const unknownCosts = usage.filter(row => row.estimatedCostMicros === null).length;
    const knownCost = usage.reduce((sum, row) => sum + (row.estimatedCostMicros ?? 0), 0);
    const totalCost = usage.length > 0 && unknownCosts === 0 ? knownCost : null;
    return {
      variant, captures_started: started.length, captures_completed: completed.length, usable_results: successful.length,
      capture_success_rate: started.length ? successful.length / started.length : 0,
      protocol_valid_rate: protocol.length ? valid / protocol.length : 0,
      legacy_fallback_rate: protocol.length ? fallback / protocol.length : 0,
      result_states: resultStates, depths, actions,
      latency_ms: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
      tokens: {
        avg_input: usage.length ? usage.reduce((sum, row) => sum + row.inputTokens, 0) / usage.length : null,
        avg_output: usage.length ? usage.reduce((sum, row) => sum + row.outputTokens, 0) / usage.length : null,
      },
      estimated_cost_micros: {
        total: totalCost, known_subtotal: knownCost, unknown_count: unknownCosts,
        avg_per_charged_capture: charged.length && totalCost !== null ? totalCost / charged.length : null,
      },
    };
  });
  return { from: query.from, to: query.to, metric_definition_version: 'usable-solve-v2', variants };
}

interface ModelPricingEntry {
  model: string;
  input_micros_per_million_tokens: number;
  output_micros_per_million_tokens: number;
}

export function estimateModelCostMicros(
  pricingJSON: string, model: string, inputTokens: number, outputTokens: number,
): number | undefined {
  try {
    const parsed = JSON.parse(pricingJSON) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const entry = parsed.find((value): value is ModelPricingEntry => {
      if (typeof value !== 'object' || value === null) return false;
      const candidate = value as Partial<ModelPricingEntry>;
      return candidate.model === model
        && Number.isFinite(candidate.input_micros_per_million_tokens)
        && Number.isFinite(candidate.output_micros_per_million_tokens)
        && (candidate.input_micros_per_million_tokens ?? -1) >= 0
        && (candidate.output_micros_per_million_tokens ?? -1) >= 0;
    });
    if (!entry) return undefined;
    return Math.round((inputTokens * entry.input_micros_per_million_tokens
      + outputTokens * entry.output_micros_per_million_tokens) / 1_000_000);
  } catch { return undefined; }
}

export function usableProductResult(event: StoredProductEvent): boolean {
  if(event.extensions?.schema_version===2&&(event.extensions.usable_result!==true||event.extensions.operation!=='solve'||event.extensions.completion_kind!=='usable'))return false;
  if (event.eventName !== 'capture_completed' || event.mode !== 'tutor' || event.depth === 'hint' || event.errorCode !== null) return false;
  if (event.extensions?.operation && event.extensions.operation !== 'solve') return false;
  if (event.extensions?.usable_result === false) return false;
  if (event.extensions?.completion_kind && event.extensions.completion_kind !== 'usable') return false;
  return (event.parserPath === 'v1' && (event.resultState === 'ready' || event.resultState === 'review'))
    || event.parserPath === 'legacy_fallback';
}
