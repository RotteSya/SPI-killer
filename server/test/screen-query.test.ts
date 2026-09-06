import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { composeScreenQuery, imageDigest, parseNoResult } from '../src/screen-query.ts';
import { validateProductEvent } from '../src/telemetry.ts';

test('no-result diagnostics reject duplicate keys, mixed results and malformed reasons', () => {
  for (const raw of [
    'NSPI_NO_RESULT_V1: {"v":1,"v":1,"reason":"multiple_targets"}',
    'NSPI_NO_RESULT_V1: {"v":true,"reason":"multiple_targets"}',
    'NSPI_NO_RESULT_V1: {"v":1,"reason":["multiple_targets"]}',
    'NSPI_NO_RESULT_V1: {"v":1,"reason":"missing_context"}',
    'FINAL: B\nNSPI_NO_RESULT_V1: {"v":1,"reason":"multiple_targets"}',
    'NSPI_NO_RESULT_V1: {"v":1,"reason":"multiple_targets"}\nextra',
  ]) {
    assert.equal(parseNoResult(raw).reason, null, raw);
    const result = composeScreenQuery(raw);
    assert.equal(result.terminalState, 'failed', raw);
    assert.equal(result.charge, false);
    assert.equal(result.reason, 'no_usable_result');
  }
});

test('large base64 image validation is bounded and reports a typed input rejection', async () => {
  const encoded = Buffer.alloc(2 * 1024 * 1024).toString('base64');
  await assert.rejects(() => imageDigest(encoded, 'image/png'), { name: 'ApiError', code: 'invalid_image' });
  for (const invalid of ['AAA=', 'AAAA====', 'A=AA', 'AA\n=', 'AAAA ']) {
    await assert.rejects(() => imageDigest(invalid, 'image/png'), { name: 'ApiError', code: 'invalid_image' });
  }
});

test('telemetry enum allowlists reject coercible arrays and objects', () => {
  const base = { event_id: randomUUID(), occurred_at: new Date().toISOString(), event_name: 'capture_started' };
  for (const [field, value] of Object.entries({ profile_id: 'spi', profile_version: 'screen-query-v1-r1',
    source_group: 'unknown', source_method: 'unknown', completion_kind: 'usable', operation: 'solve' })) {
    assert.ok(validateProductEvent({ ...base, [field]: value }, 'test'));
    assert.equal(validateProductEvent({ ...base, [field]: [value] }, 'test'), null);
    assert.equal(validateProductEvent({ ...base, [field]: { toString: () => value } }, 'test'), null);
  }
});
