#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {readdir, readFile, lstat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve, relative, join, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const self = fileURLToPath(import.meta.url);

async function files(directory) {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink(), 'Use vercel build --standalone: ' + path);
    if (stat.isDirectory()) entries.push(...await files(path));
    else { assert.ok(stat.isFile()); entries.push({path, bytes: stat.size}); }
  }
  return entries;
}

async function smoke(functionDirectory) {
  // The parent starts this process with an allowlisted environment and no credentials.
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.VERCEL, '1');
  assert.equal(process.env.OFFICIAL_PROVIDER, 'mock');
  const appRoot = join(functionDirectory, 'server');
  const require = createRequire(join(appRoot, 'package.json'));
  const sharp = require('sharp');
  const {imageDigest} = await import(pathToFileURL(join(appRoot, 'src/image-validation.js')));
  const png = await sharp({create: {width: 64, height: 64, channels: 3, background: 'white'}}).png().toBuffer();
  assert.equal(await imageDigest(png.toString('base64'), 'image/png'), sha256(png));
  await assert.rejects(imageDigest(png.subarray(0, png.length - 4).toString('base64'), 'image/png'), e => e.code === 'invalid_image');
  // Exercise traced dynamic imports without connecting to any external database.
  const {PostgresStore} = await import(pathToFileURL(join(appRoot, 'src/db-postgres.js')));
  assert.equal(typeof PostgresStore, 'function');
  const {SqliteStore} = await import(pathToFileURL(join(appRoot, 'src/db-sqlite.js')));
  const sqlite = new SqliteStore(':memory:'); await sqlite.close();
  const {default: handler} = await import(pathToFileURL(join(appRoot, 'api/index.js')));
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, options = {}) => fetch(base + path, {...options, redirect: 'error', signal: AbortSignal.timeout(5000)});
  const checks = [];
  try {
    const health = await request('/healthz'); assert.equal(health.status, 200);
    const state = await health.json();
    assert.equal(state.db, 'memory'); assert.equal(state.provider, 'mock'); assert.equal(state.payments, 'disabled');
    checks.push('bundled_handler_health');
    for (const language of ['ja', 'en', 'zh']) {
      const page = await request('/reading-practice?lang=' + language); assert.equal(page.status, 200);
      assert.match(await page.text(), new RegExp('<html lang="' + language));
    }
    checks.push('three_language_pages');
    for (const path of ['/src/config.ts', '/test/api.test.ts', '/tsconfig.json']) {
      const response = await request(path); assert.equal(response.status, 404); await response.arrayBuffer();
    }
    checks.push('source_and_tests_not_routed');
    const rejected = await request('/api/internal/reap'); assert.equal(rejected.status, 401); await rejected.arrayBuffer();
    const reaped = await request('/api/internal/reap', {headers: {authorization: 'Bearer ' + process.env.CRON_SECRET}});
    assert.equal(reaped.status, 200); assert.equal((await reaped.json()).processed, 0);
    checks.push('authenticated_reaper');
    const registered = await request('/v1/devices', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({platform: 'macos', app_version: 'bundle-verification'})});
    assert.equal(registered.status, 200);
    const account = await registered.json(); assert.equal(account.balance_questions, 30);
    const headers = {authorization: 'Bearer ' + account.device_token, 'content-type': 'application/json'};
    const capture = await request('/v1/captures', {method: 'POST', headers,
      body: JSON.stringify({system: 'Bundle verification', task: 'Verify transport', image_base64: png.toString('base64'), image_media_type: 'image/png'})});
    assert.equal(capture.status, 200); assert.match(capture.headers.get('content-type'), /^text\/event-stream/);
    const stream = await capture.text();
    assert.ok(stream.endsWith('data: [DONE]\n\n'));
    const events = stream.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const usage = events.filter(event => event.type === 'usage');
    assert.equal(usage.length, 1); assert.ok(events.some(event => event.type === 'delta'));
    assert.equal(events.at(-1).type, 'usage'); assert.equal(usage[0].questions_charged, 1);
    assert.equal(usage[0].balance_questions, 29);
    const balance = await request('/v1/account', {headers}); assert.equal(balance.status, 200);
    assert.equal((await balance.json()).balance_questions, 29);
    checks.push('fixed30_registration_and_legacy_sse_settlement');
    assert.equal(sharp.counters().process, 0); assert.equal(sharp.counters().queue, 0); assert.equal(sharp.cache().items.current, 0);
    return {checks, native_image_validation: true, dynamic_sqlite_and_postgres_imports: true,
      sharp: sharp.versions.sharp, vips: sharp.versions.vips, paid_model_calls: 0, customer_data_used: false};
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
}

if (process.argv[2] === '--smoke') {
  console.log(JSON.stringify(await smoke(resolve(process.argv[3]))));
} else {
  const args = process.argv.slice(2), allowHost = args.includes('--allow-host-platform');
  const paths = args.filter(arg => arg !== '--allow-host-platform');
  assert.equal(paths.length, 1, 'Usage: node scripts/verify-vercel-output.mjs <output-directory> [--allow-host-platform]');
  if (!allowHost) { assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); }
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const output = resolve(paths[0]), outputConfig = JSON.parse(await readFile(join(output, 'config.json'), 'utf8'));
  assert.equal(outputConfig.version, 3);
  assert.ok(outputConfig.routes.some(route => route.dest === '/api'), 'The Fastify rewrite must be present');
  const staticFiles = await files(join(output, 'static'));
  assert.deepEqual(staticFiles.map(file => relative(join(output, 'static'), file.path)), ['robots.txt'], 'Unexpected public source, test or asset');
  const robots = await readFile(new URL('../server/public/robots.txt', import.meta.url));
  assert.deepEqual(await readFile(staticFiles[0].path), robots, 'Static asset differs from reviewed source');
  const functionDirectory = join(output, 'functions/api/index.func');
  const outputFiles = await files(join(output, 'functions'));
  const configs = outputFiles.filter(file => file.path.endsWith('/.vc-config.json'));
  assert.equal(configs.length, 1); assert.equal(configs[0].path, join(functionDirectory, '.vc-config.json'));
  const config = JSON.parse(await readFile(configs[0].path, 'utf8'));
  assert.equal(config.runtime, 'nodejs24.x'); assert.equal(config.maxDuration, 300);
  assert.equal(config.handler, 'server/api/index.js');
  assert.equal(config.architecture, process.arch === 'x64' ? 'x86_64' : process.arch);
  assert.deepEqual(config.environment, {}, 'No build credentials may be embedded');
  const totalBytes = outputFiles.reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(totalBytes < 250 * 1024 * 1024);
  const manifest = [];
  for (const file of outputFiles) {
    const name = relative(functionDirectory, file.path);
    assert.ok(!name.startsWith('..') && !isAbsolute(name), 'Unexpected function payload');
    assert.ok(!/(^|\/)\.env(?:\.|$)|(^|\/)server\/test\/|\.(?:db|sqlite)(?:$|-)/.test(name), 'Private or test file in function');
    const bytes = await readFile(file.path);
    if (!allowHost && name.endsWith('.node')) {
      assert.deepEqual(bytes.subarray(0, 4), Buffer.from([127, 69, 76, 70])); assert.equal(bytes.readUInt16LE(18), 62);
    }
    manifest.push({path: name, bytes: file.bytes, sha256: sha256(bytes)});
  }
  const env = {PATH: process.env.PATH, NODE_ENV: 'test', VERCEL: '1', OFFICIAL_PROVIDER: 'mock', LOG_LEVEL: 'silent', CRON_SECRET: randomBytes(32).toString('hex')};
  const child = spawnSync(process.execPath, [self, '--smoke', functionDirectory], {env, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024});
  assert.equal(child.error, undefined); assert.equal(child.signal, null);
  assert.equal(child.status, 0, 'Bundled smoke failed: ' + child.stderr);
  const result = JSON.parse(child.stdout);
  console.log(JSON.stringify({schema_version: 1, passed: true, recorded_at: new Date().toISOString(),
    node: process.versions.node, platform: process.platform, architecture: process.arch,
    scope: allowHost ? 'host diagnostic; not a Linux release artifact' : 'native Linux packaged function verification; not a deployed Vercel runtime',
    static_files: ['robots.txt'], function_bytes: totalBytes, function_file_count: manifest.length,
    output_config_sha256: sha256(await readFile(join(output, 'config.json'))), smoke: result, files: manifest}));
}
