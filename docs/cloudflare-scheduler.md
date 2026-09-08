# Cloudflare recovery scheduler

The `notchspi-reaper` Worker invokes the existing authenticated `GET https://notchspi-api.vercel.app/api/internal/reap`. Its payload has no database, payment, or model credentials. Only `CRON_SECRET` is shared with the Vercel production environment. Each invocation performs one request with a 45-second deadline, rejects redirects and non-200 responses, reads at most 4 KiB, validates the recovery counters, and fails the scheduled event on partial reconciliation failures. Logs contain counts, timestamps and status, never response bodies or credentials. Public Worker and preview URLs are disabled.

The source configuration starts with **no active triggers**. Activate `* * * * *` only after the compatible production server, database migration, shared secret and authenticated endpoint probe have passed. The current production server predates this endpoint; calling it now cannot recover reservations. Vercel's minute cron has been removed from the candidate configuration, so deployment no longer requires a Vercel paid scheduler. No Cloudflare paid plan was purchased.

Verification from `scheduler`: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Unit tests cover credential handling, HTTP errors, malformed/oversized results, partial failures and public invocation. A separate workerd test dispatches a scheduled event against an isolated outbound service. This detected the runtime's rejection of `redirect: error`; the implementation uses `manual` and explicitly rejects 3xx. Tests never call production.

Deployment order:

1. Verify the stored production credential and the Worker binding match, without printing either.
2. Complete the server migration and compatibility release gates. Probe the actual production endpoint with and without authorization; require a valid 200 recovery result and a 401 denial.
3. Set `scheduler/wrangler.jsonc` triggers to `* * * * *` and apply that schedule through Cloudflare. Preserve the existing secret and disabled public URLs.
4. Allow trigger propagation and collect successful real scheduled events, including a controlled expired reservation. Confirm exactly one release/settlement in the persistent ledger.
5. Record activation time, deployment ID and evidence. Rollback removes the schedule first; the server's durable sweep tolerates overlaps and retries.

Cloudflare documents [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [free-plan limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/). A minute schedule makes 1,440 invocations/day; deployment does not subscribe the account to a paid plan. The authenticated Workers plans dashboard confirmed this account's current plan is **Free / $0** on 2026-09-08; evidence is `cloudflare-free-plan.json`. The connector's billing-read limitation does not block this verification.

## Initial model budget

The approved production settings are in [`production-model-budget.json`](../deploy/production-model-budget.json): CNY 20 per Shanghai calendar day, shared by all official solves, explanations and recovery attempts. The test races 25 reservations across four accounts and verifies only 20 one-yuan reservations fit, with a fresh window only at Shanghai midnight. Server hosting is separate; no model call means no model debit. The seven-day review starts when production is activated and never increases the cap automatically.

Model attempts retain their own currency/pricing version; historical USD rows are not relabelled. New costs use a conservative CNY valuation at 8 CNY/USD, above the 2026-09-08 BOC quote, and DeepSeek peak cache-miss prices. Claude Opus 4.8 costs USD 5/25 per million input/output tokens; DeepSeek vision costs USD 0.44/1.32 at peak. These are budget estimates, reconciled against actual provider statements, not a claim that the invoices charge those CNY rates.

The initial per-attempt hold is CNY 10. For the current Claude control route, two 32,000-UTF-16-unit text limits imply at most 192,000 UTF-8 bytes, four images at most 19,136 visual tokens, plus an overhead margin and 4,096 output tokens; the conservative total remains below CNY 10. DeepSeek's entire 1M context plus 4,096 output tokens is below CNY 4 at these prices. Unknown usage retains the hold. A hold is released down to observed usage after success; near the daily limit, new requests may stop before CNY 20 if the remaining balance cannot cover a full hold. Do not raise the daily cap to compensate.

Before activation, validate the **actual** provider/model IDs, endpoints, output limits, price coverage and per-attempt bound. Recheck the FX ceiling and published prices; stale or mismatched assumptions block activation. Freeze currency, budget timezone and pricing throughout a live budget window. Changing them can create a different window and must be performed only after draining calls with a reconciled transition. Existing data remains intact.
