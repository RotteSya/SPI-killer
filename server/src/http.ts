import type { FastifyReply } from 'fastify';

// The client's contract error body: {"error": {"message": "<user-readable>", "code": "<slug>"}}.
// `code` lets the client localize known failure classes (the message is a server-side fallback
// for clients that don't know the code). Thrown anywhere in a handler and translated to this
// shape by the error hook in routes.ts.

export type ErrorCode =
  | 'insufficient_quota' // 402 — question balance is used up
  | 'invalid_token'      // 401 — unknown/expired device token
  | 'bad_request'        // 400 — malformed input
  | 'rate_limited'       // 429 — too many requests (registration / capture concurrency)
  | 'upstream_error'     // 502 — the model vendor call failed
  | 'not_found'          // 404
  | 'idempotency_conflict' | 'capture_in_progress' | 'capture_already_finalized' | 'device_busy' | 'service_maintenance'
  | 'invalid_scope' | 'invalid_image' | 'unsupported_scope' | 'multiple_targets' | 'no_usable_result'
  | 'feature_disabled' | 'budget_exceeded' | 'expired' | 'binding_mismatch'
  | 'report_details_expired' | 'report_changed'
  | 'payload_too_large'  // 413 — rejected before capture admission
  | 'internal';          // 500

export class ApiError extends Error {
  statusCode: number;
  code: ErrorCode;
  constructor(statusCode: number, message: string, code?: ErrorCode) {
    super(message);
    this.statusCode = statusCode;
    this.code = code ?? defaultCode(statusCode);
    this.name = 'ApiError';
  }
}

function defaultCode(statusCode: number): ErrorCode {
  switch (statusCode) {
    case 400: return 'bad_request';
    case 401: return 'invalid_token';
    case 402: return 'insufficient_quota';
    case 404: return 'not_found';
    case 429: return 'rate_limited';
    case 502: return 'upstream_error';
    default: return 'internal';
  }
}

export function errorBody(message: string, code: ErrorCode): {
  error: { message: string; code: ErrorCode };
} {
  return { error: { message, code } };
}

// --- SSE (Server-Sent Events) for POST /v1/captures ---------------------------------------

// Every stream event the contract defines. `data: <json>` lines, one JSON object per event.
export type StreamEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'usage';
      input_tokens: number;
      output_tokens: number;
      questions_charged: number;
      balance_questions: number;
      capture_id?: string;
      operation?: 'solve' | 'explain' | 'recover';
      terminal_state?: 'usable' | 'retake' | 'no_result' | 'failed' | 'canceled';
      balance_version?: string;
      account_totals?: { questions: number; input_tokens: number; output_tokens: number };
      held_questions?: number;
      can_retry?: boolean;
      can_recover?: boolean;
      settlement_status?: 'held' | 'settled' | 'released' | 'not_required';
      usable_result?: boolean;
      explanation_available?: boolean;
      explanation_expires_at?: string;
    }
  | { type: 'error'; error: { message: string; code: ErrorCode } };

/** Serialize one event to an SSE `data:` frame (pure — unit-tested). */
export function sseFrame(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** The terminal sentinel line the client watches for. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** Prepare a Fastify reply for streaming SSE and hand back a raw writer. */
export function beginSSE(reply: FastifyReply): (event: StreamEvent) => void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so deltas flush promptly
  });
  return (event: StreamEvent) => reply.raw.write(sseFrame(event));
}
