#!/usr/bin/env node
// Drift guards for version, docs, env, and generated artifacts. Node stdlib only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const fail = (msg) => errors.push(msg);

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));

const walk = (rel, pred) => {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = path.relative(REPO_ROOT, full);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.build' || ent.name === 'dist' || ent.name === 'dist-qa') continue;
        stack.push(full);
      } else if (!pred || pred(relPath, ent.name)) {
        out.push(relPath);
      }
    }
  }
  return out;
};

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : err.message;
    fail(`git ${args.join(' ')} failed: ${stderr}`);
    return '';
  }
};

const tracked = () => git(['ls-files']).split('\n').filter(Boolean);

// --- VERSION.env -----------------------------------------------------------------

const loadVersionEnv = () => {
  const rel = 'VERSION.env';
  if (!exists(rel)) {
    fail('VERSION.env is missing');
    return null;
  }
  const keys = new Map();
  for (const raw of read(rel).split(/\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) {
      fail(`VERSION.env: malformed line: ${line}`);
      continue;
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (keys.has(key)) fail(`VERSION.env: duplicate key ${key}`);
    keys.set(key, value);
  }
  const allowed = ['APP_VERSION', 'BUILD_NUMBER'];
  for (const key of keys.keys()) {
    if (!allowed.includes(key)) fail(`VERSION.env: unexpected key ${key}`);
  }
  for (const key of allowed) {
    if (!keys.has(key)) fail(`VERSION.env: missing ${key}`);
  }
  const app = keys.get('APP_VERSION') ?? '';
  const build = keys.get('BUILD_NUMBER') ?? '';
  if (!/^[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(app)) {
    fail(`VERSION.env: APP_VERSION must look like 1.2 or 1.2.3 (got '${app}')`);
  }
  if (!/^[0-9]+$/.test(build)) {
    fail(`VERSION.env: BUILD_NUMBER must be an integer (got '${build}')`);
  }
  const tag = `v${app}`;
  if (!/^v[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(tag)) {
    fail(`Git tag format v\${APP_VERSION} is invalid: ${tag}`);
  }
  return { app, build, tag };
};

const version = loadVersionEnv();

if (exists('scripts/package.sh')) {
  const pkg = read('scripts/package.sh');
  if (!pkg.includes('VERSION.env')) {
    fail('scripts/package.sh must read CFBundle versions from VERSION.env');
  }
  if (/VERSION="[0-9]+\.[0-9]+/.test(pkg) || /CFBundleVersion<\/key><string>[0-9]+/.test(pkg)) {
    fail('scripts/package.sh must not hardcode CFBundle version values');
  }
}

if (exists('Sources/NotchSPI/Update/UpdateChecker.swift')) {
  const src = read('Sources/NotchSPI/Update/UpdateChecker.swift');
  if (src.includes('devFallbackVersion')) {
    fail('UpdateChecker.swift still defines devFallbackVersion; read VERSION.env or return 0.0.0-dev');
  }
  if (/=\s*"2\.\d+"/.test(src)) {
    fail('UpdateChecker.swift still contains a hardcoded marketing version');
  }
}

// --- Markdown relative links -----------------------------------------------------

const mdFiles = [
  ...new Set([
    ...tracked().filter((f) => f.endsWith('.md') && exists(f)),
    ...walk('.', (_rel, name) => name.endsWith('.md')),
  ]),
];
const linkRe = /\[[^\]]*]\(([^)]+)\)/g;
for (const file of mdFiles) {
  const text = read(file);
  let m;
  while ((m = linkRe.exec(text))) {
    let target = m[1].trim().split(/\s+/)[0];
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split('#')[0];
    if (!target) continue;
    const resolved = path.normalize(path.join(path.dirname(path.join(REPO_ROOT, file)), target));
    if (!resolved.startsWith(REPO_ROOT)) {
      fail(`${file}: link escapes repo: ${m[1]}`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      fail(`${file}: broken relative link ${m[1]}`);
    }
  }
}

// --- Path assumptions in docs that must stay portable ----------------------------

const portableDocs = ['README.md'];
if (exists('HANDOVER.md')) portableDocs.push('HANDOVER.md');
if (exists('AGENTS.md')) portableDocs.push('AGENTS.md');
if (exists('HANDOVER.md') && exists('CLAUDE.md')) portableDocs.push('CLAUDE.md');
const machinePath = /\/Users\/|~\/Developer\/|\/native\//;
for (const file of portableDocs) {
  if (!exists(file)) continue;
  const text = read(file);
  if (machinePath.test(text)) {
    fail(`${file} contains a machine-local or nested-native path assumption`);
  }
}

// --- AI pointer files ------------------------------------------------------------

const pointerCheck = (file) => {
  if (!exists(file)) return;
  if (!exists('HANDOVER.md')) return;
  const lines = read(file).split(/\n/);
  const nonempty = lines.filter((l) => l.trim() !== '');
  if (nonempty.length > 5) fail(`${file} must stay a short pointer (≤ 5 non-empty lines)`);
  const text = read(file);
  if (!text.includes('HANDOVER.md')) fail(`${file} must point at HANDOVER.md`);
};

pointerCheck('AGENTS.md');
pointerCheck('CLAUDE.md');

// --- Env var parity --------------------------------------------------------------

const PLATFORM_ENV = new Set([
  'VERCEL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'DATABASE_URL',
  'NODE_ENV',
  'PATH',
  'HOME',
  'LOG_LEVEL',
]);

const usedEnv = new Set();
const envCall = /\b(?:envStr|envInt)\(\s*'([A-Z][A-Z0-9_]*)'/g;
const processEnv = /process\.env\.([A-Z][A-Z0-9_]*)/g;
for (const file of walk('server', (rel) => rel.endsWith('.ts') && !rel.includes(`${path.sep}test${path.sep}`))) {
  if (file.startsWith(`server${path.sep}test${path.sep}`)) continue;
  const text = read(file);
  let m;
  while ((m = envCall.exec(text))) usedEnv.add(m[1]);
  while ((m = processEnv.exec(text))) usedEnv.add(m[1]);
}

const exampleVars = new Set();
if (exists('server/.env.example')) {
  for (const raw of read('server/.env.example').split(/\n/)) {
    const line = raw.replace(/^\s*#\s*/, '');
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) exampleVars.add(m[1]);
  }
} else {
  fail('server/.env.example is missing');
}

for (const name of usedEnv) {
  if (PLATFORM_ENV.has(name)) continue;
  if (!exampleVars.has(name)) fail(`config uses ${name} but server/.env.example does not list it`);
}
for (const name of exampleVars) {
  if (PLATFORM_ENV.has(name)) continue;
  if (!usedEnv.has(name)) fail(`server/.env.example lists ${name} which is not read by server source`);
}

// --- official-api.md client paths exist in routes.ts -----------------------------

if (exists('docs/official-api.md') && exists('server/src/routes.ts')) {
  const api = read('docs/official-api.md');
  const routes = read('server/src/routes.ts');
  const heading = /^(?:#{1,6})\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]+)/gm;
  let m;
  const documented = [];
  while ((m = heading.exec(api))) {
    const method = m[1];
    const routePath = m[2].replace(/[.?].*$/, '').replace(/<[^>]+>/g, ':param');
    documented.push({ method, path: m[2].split('?')[0] });
    const literal = m[2].split('?')[0].replace(/<[^>]+>/g, '');
    const lookup = literal.replace(/\/$/, '');
    const routeNeedle = lookup.replace(/\\/g, '');
    if (!routes.includes(`'${routeNeedle}`) && !routes.includes(`"${routeNeedle}`) && !routes.includes(`\`${routeNeedle}`)) {
      // /topup is registered as '/topup'; /v1/devices as '/v1/devices'
      const base = routeNeedle.split('/:')[0];
      if (!routes.includes(`'${base}`) && !routes.includes(`"${base}`)) {
        fail(`docs/official-api.md documents ${method} ${m[2]} which is not in server/src/routes.ts`);
      }
    }
  }
}

// --- Tracked generated artifacts -------------------------------------------------

const trackedFiles = tracked();
const forbidden = [
  /^\.build\//,
  /\/node_modules\//,
  /^server\/node_modules\//,
  /^dist\//,
  /^dist-qa\//,
  /^\.eval-results\//,
  /^server\/data\//,
  /^server\/\.env$/,
  /\.db(-wal|-shm)?$/,
];
for (const file of trackedFiles) {
  if (forbidden.some((re) => re.test(file))) {
    fail(`generated or secret path is tracked: ${file}`);
  }
}

// --- Secrets and private tool paths in tracked files -----------------------------

const secretRe = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-live-[A-Za-z0-9]{20,}/,
  /rk_live_[A-Za-z0-9]{16,}/,
  /whsec_[A-Za-z0-9]{16,}/,
  /postgres(?:ql)?:\/\/[^:\s\/]+:[^@\s]{12,}@/,
];
const privateTool = /\$HOME\/\.claude\/skills\//;
for (const file of trackedFiles) {
  if (file.endsWith('.lock') || file.includes('node_modules')) continue;
  let text;
  try {
    text = read(file);
  } catch {
    continue;
  }
  if (file === 'server/.env.example') continue;
  for (const re of secretRe) {
    if (re.test(text)) fail(`${file} matches a live-looking secret pattern`);
  }
  if (file === 'scripts/publish-quark.sh') continue;
  if (privateTool.test(text)) fail(`${file} references a private absolute tool path`);
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL  ${e}`);
  console.error(`repo-health: ${errors.length} issue(s)`);
  process.exit(1);
}

console.log('repo-health: ok');
if (version) {
  console.log(`  APP_VERSION=${version.app} BUILD_NUMBER=${version.build} tag=${version.tag}`);
}
