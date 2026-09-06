import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';

// This process exercises the real app/JSON parser with the deployment platform selected.
process.env.VERCEL = '1'; process.env.NODE_ENV = 'test'; process.env.REQUIRE_DURABLE_STORAGE = '0';
process.env.OFFICIAL_PROVIDER = 'mock'; process.env.OBJECTIVE_PROVIDER = 'mock';
process.env.PAYMENT_PROVIDER = 'stub'; process.env.LOG_LEVEL = 'silent';
delete process.env.POSTGRES_URL; delete process.env.DATABASE_URL;
const {buildApp} = await import('../src/index.ts');
let providerCalls = 0;
const app = await buildApp({provider: {name: 'mock', async stream() { providerCalls++; throw new Error('No ingress test may call a provider'); }}});
await app.listen({host: '127.0.0.1', port: 0});
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('Isolated listener unavailable');
const base = `http://127.0.0.1:${address.port}`;
after(async () => { await app.close(); });

async function post(bytes: number, chunked: boolean) {
  const body = Buffer.from(JSON.stringify({padding: 'a'.repeat(bytes - 14)}));
  assert.equal(body.length, bytes);
  return new Promise<{status: number; json: {error: {code: string}}}>((resolve, reject) => {
    const req = request(base + '/v1/captures', {method: 'POST', headers: {'Content-Type': 'application/json',
      ...(!chunked ? {'Content-Length': body.length} : {})}}, res => {
      let output = '';
      res.on('data', chunk => { output += String(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { resolve({status: res.statusCode!, json: JSON.parse(output)}); } catch (e) { reject(e); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Ingress request deadline exceeded')));
    req.on('error', reject);
    if (chunked) for (let at = 0; at < body.length; at += 65_536) req.write(body.subarray(at, at + 65_536));
    // The parser can reject an oversized Content-Length before reading any body.
    // Sending megabytes after that response races the closed socket (EPIPE).
    // Chunked coverage below independently checks the received-byte boundary.
    else if (bytes <= 4_500_000) req.write(body);
    req.end();
  });
}
for (const chunked of [false,true]) {
  test(`Vercel ingress bounds ${chunked ? 'chunked' : 'Content-Length'} JSON before authentication and model work`, async () => {
    const accepted = await post(4_500_000, chunked);
    assert.equal(accepted.status, 401, 'A body at the ingress ceiling reaches the authentication layer');
    const denied = await post(4_500_001, chunked);
    assert.equal(denied.status, 413); assert.equal(denied.json.error.code, 'payload_too_large');
    assert.equal(providerCalls, 0);
    const health = await fetch(base + '/healthz'); assert.equal(health.status, 200);
  });
}
