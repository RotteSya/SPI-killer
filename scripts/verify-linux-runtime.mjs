#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';

// Run in the isolated Node 24 x86_64 Linux target with a real 1 GiB cgroup ceiling.
// This exercises native code and memory bounds; it does not establish production latency.
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(Number(process.versions.node.split('.')[0]), 24);
const memoryLimit = Number((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim());
assert.equal(memoryLimit, 1024 * 1024 * 1024, 'Use an isolated container with --memory=1024m');
const sharp = createRequire(new URL('../server/package.json', import.meta.url))('sharp');
// sharp's CJS and ESM wrappers each enable the shared native cache during module
// initialization. Load the diagnostic wrapper first so production config wins.
const {imageDigest, imageDigests} = await import('../server/src/image-validation.ts');
const loop = monitorEventLoopDelay({resolution: 20});
const samples = []; let peakRSS = 0, peakHeap = 0;
const sample = () => { const m = process.memoryUsage(); peakRSS = Math.max(peakRSS, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
const sampler = setInterval(sample, 50); sampler.unref(); loop.enable();
const started = performance.now();
try {
  const png = await sharp({create: {width: 4000, height: 4000, channels: 4, background: {r: 13, g: 79, b: 131, alpha: 1}}}).png().toBuffer();
  const encoded = png.toString('base64'), expected = createHash('sha256').update(png).digest('hex');
  const before = process.memoryUsage();
  let busyRejections = 0, successfulDecodes = 0;
  for (let round = 0; round < 8; round++) {
    const at = performance.now();
    const results = await Promise.allSettled(Array.from({length: 3}, () => imageDigest(encoded, 'image/png')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    for (const result of results) {
      if (result.status === 'fulfilled') { assert.equal(result.value, expected); successfulDecodes++; }
      else { assert.equal(result.reason.statusCode, 503); assert.equal(result.reason.code, 'rate_limited'); busyRejections++; }
    }
    sample(); samples.push({round, milliseconds: performance.now() - at, rss: process.memoryUsage().rss});
  }
  assert.deepEqual(await imageDigests(Array.from({length: 4}, () => ({base64: encoded, mediaType: 'image/png'}))), Array(4).fill(expected));
  successfulDecodes += 4;
  await assert.rejects(imageDigest(png.subarray(0, png.length - 4).toString('base64'), 'image/png'), e => e.code === 'invalid_image');
  const oversized = await sharp({create: {width: 4001, height: 4000, channels: 3, background: 'white'}}).png().toBuffer();
  await assert.rejects(imageDigest(oversized.toString('base64'), 'image/png'), e => e.code === 'invalid_image');
  assert.equal(await imageDigest(encoded, 'image/png'), expected); successfulDecodes++;
  // The accepted PNG format also permits 16-bit RGBA, with larger native buffers.
  const png16 = await sharp(png).toColourspace('rgb16').png().toBuffer();
  assert.equal(png16[24], 16); assert.equal(png16[25], 6);
  const encoded16 = png16.toString('base64'), expected16 = createHash('sha256').update(png16).digest('hex');
  for (let round = 0; round < 2; round++) {
    const results = await Promise.allSettled(Array.from({length: 3}, () => imageDigest(encoded16, 'image/png')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    for (const result of results) {
      if (result.status === 'fulfilled') { assert.equal(result.value, expected16); successfulDecodes++; }
      else { assert.equal(result.reason.statusCode, 503); assert.equal(result.reason.code, 'rate_limited'); busyRejections++; }
    }
    sample();
  }
  sample();
  const nativePeak = process.resourceUsage().maxRSS * 1024;
  const cgroupPeak = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
  assert.ok(nativePeak < memoryLimit); assert.ok(cgroupPeak <= memoryLimit);
  assert.equal(sharp.counters().process, 0); assert.equal(sharp.counters().queue, 0);
  assert.equal(sharp.cache().items.current, 0);
  const header = process.report.getReport().header;
  console.log(JSON.stringify({schema_version: 2, passed: true, node: process.versions.node, platform: process.platform,
    architecture: process.arch, glibc: header.glibcVersionRuntime, os_release: await readFile('/etc/os-release','utf8'),
    native_versions: sharp.versions, native_cache: sharp.cache(), native_counters: sharp.counters(),
    native_concurrency: sharp.concurrency(), memory_limit_bytes: memoryLimit, cgroup_peak_bytes: cgroupPeak,
    native_peak_rss_bytes: nativePeak, sampled_peak_rss_bytes: peakRSS, sampled_peak_heap_bytes: peakHeap,
    before, after: process.memoryUsage(), successful_decodes: successfulDecodes, busy_rejections: busyRejections,
    pixels_per_valid_image: 16_000_000, original_image_sha256: expected, original_image_bytes: png.length,
    high_depth_image: {bits_per_channel: 16, channels: 4, successful_decodes: 4, original_sha256: expected16, original_bytes: png16.length},
    duration_ms: performance.now() - started, rounds: samples,
    event_loop_p95_ms: Number.isFinite(loop.percentile(95)) ? loop.percentile(95) / 1e6 : null,
    timing_scope: 'Isolated x86_64 Linux resource diagnostics; no production latency claim',
    network_model_calls: 0, customer_data_used: false}));
} finally { clearInterval(sampler); loop.disable(); }
