'use strict';
/**
 * Scrubber engine latency, in process.
 *
 *   node bench/scrub_latency.js [--json <file>] [--iterations <n>] [--cold <n>]
 *
 * Measures tokenize() (every layer, in-memory vault, exact values from a
 * clean environment) and scan() for 256 B, 4 KB and 64 KB inputs:
 *   - benign: real files from the benign corpus (or a built-in snippet)
 *   - dense:  the same text with a fake secret or PII value every ~1 KB
 * plus the cost of a cold Node process that loads the engine and tokenizes
 * 4 KB once (the floor of a hook process).
 *
 * Prints a Markdown table with the hardware, OS, Node version and date.
 * Fake values only (test/fixtures/fake_secrets.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'packages', 'zn-gate');
const engine = require(path.join(PKG, 'lib', 'scrub', 'engine.js'));
const { generateAll } = require(path.join(PKG, 'test', 'fixtures', 'fake_secrets.js'));
const CORPUS = path.join(PKG, 'test', 'fixtures', 'benign');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const ITER = Number(opt('--iterations', 200));
const COLD = Number(opt('--cold', 10));
const JSON_OUT = opt('--json', null);
const SIZES = [['256B', 256], ['4KB', 4096], ['64KB', 65536]];

function vault() {
  const m = new Map();
  const counters = new Map();
  return {
    async mapToken(p, type, value) {
      const k = type + '\0' + value;
      if (!m.has(k)) { const n = (counters.get(type) || 0) + 1; counters.set(type, n); m.set(k, '__ZN_' + type + '_' + n + '__'); }
      return m.get(k);
    },
    async resolve() { return null; },
    async exactValues() { return []; },
    async audit() {},
  };
}

function benignText(bytes) {
  let acc = '';
  if (fs.existsSync(CORPUS)) {
    const stack = [CORPUS];
    while (stack.length && acc.length < bytes) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.(py|js)$/.test(e.name) && acc.length < bytes) acc += fs.readFileSync(p, 'utf8') + '\n';
      }
    }
  }
  if (acc.length < 256) acc = 'function parseArgs(argv) { return argv.filter(Boolean); }\n// fetch token from process.env.API_KEY\n';
  while (acc.length < bytes) acc += acc;
  return { text: acc.slice(0, bytes), source: fs.existsSync(CORPUS) ? 'corpus' : 'builtin' };
}

function denseText(base) {
  const { secrets, pii } = generateAll(1337005, { perType: 4, piiPerType: 4 });
  const values = secrets.concat(pii).map((s) => s.value.replace(/\n/g, ' '));
  let out = '';
  let i = 0;
  for (let at = 0; at < base.length; at += 1024) {
    out += base.slice(at, at + 1024 - 80) + '\nKEY=' + values[i++ % values.length] + '\n';
  }
  return out.slice(0, base.length);
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function time(fn, n) {
  for (let i = 0; i < Math.min(20, n); i++) await fn();
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  const r = (x) => Math.round(x * 1000) / 1000;
  return { p50: r(pct(t, 50)), p95: r(pct(t, 95)), p99: r(pct(t, 99)), n };
}

async function main() {
  const base = benignText(65536);
  const dense = denseText(base.text);
  const ctx = { project: 'latency', agent: 'bench', tool: 'Read', destination: 'assistant', vault: vault(), env: {}, exactFiles: false };
  const results = {};
  for (const [label, bytes] of SIZES) {
    const n = bytes >= 65536 ? Math.max(20, Math.floor(ITER / 4)) : ITER;
    const b = base.text.slice(0, bytes);
    const d = dense.slice(0, bytes);
    results[label] = {
      tokenize_benign: await time(() => engine.tokenize(b, ctx), n),
      tokenize_dense: await time(() => engine.tokenize(d, ctx), n),
      scan_benign: await time(() => engine.scan(b, ctx), n),
    };
  }
  // Cold process: require the engine and tokenize 4 KB once.
  const coldScript = 'const e=require(' + JSON.stringify(path.join(PKG, 'lib', 'scrub', 'engine.js')) + ');' +
    'e.tokenize(' + JSON.stringify(dense.slice(0, 4096)) + ',{project:"c",vault:null,env:{},exactFiles:false}).then(()=>{})';
  const cold = [];
  for (let i = 0; i < COLD; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, ['-e', coldScript], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('cold run failed');
    cold.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  cold.sort((a, b) => a - b);
  const baseline = [];
  for (let i = 0; i < COLD; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    baseline.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  baseline.sort((a, b) => a - b);

  const cpu = os.cpus()[0] ? os.cpus()[0].model.replace(/\s+/g, ' ').trim() : 'unknown';
  const env = {
    date: new Date().toISOString(),
    cpu,
    cores: os.cpus().length,
    os: os.platform() + ' ' + os.release(),
    node: process.version,
    load: os.loadavg().map((x) => Math.round(x * 100) / 100),
    payload: base.source,
  };
  const report = { env, results, cold_process_ms: { p50: Math.round(pct(cold, 50) * 10) / 10, node_baseline_p50: Math.round(pct(baseline, 50) * 10) / 10, n: COLD } };
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n');

  const lines = [];
  lines.push('Hardware: ' + cpu + ' x' + env.cores + ' | ' + env.os + ' | Node ' + env.node + ' | ' + env.date.slice(0, 10) + ' | load ' + env.load.join('/') + ' | payload ' + env.payload);
  lines.push('');
  lines.push('| Size | tokenize benign p50 / p95 / p99 (ms) | tokenize dense p50 / p95 / p99 (ms) | scan benign p50 / p95 (ms) |');
  lines.push('|---|---|---|---|');
  for (const [label] of SIZES) {
    const r = results[label];
    lines.push('| ' + label + ' | ' + [r.tokenize_benign.p50, r.tokenize_benign.p95, r.tokenize_benign.p99].join(' / ') +
      ' | ' + [r.tokenize_dense.p50, r.tokenize_dense.p95, r.tokenize_dense.p99].join(' / ') +
      ' | ' + [r.scan_benign.p50, r.scan_benign.p95].join(' / ') + ' |');
  }
  lines.push('');
  lines.push('Cold process (load engine + tokenize 4 KB once): p50 ' + report.cold_process_ms.p50 + ' ms; bare `node -e 0`: p50 ' + report.cold_process_ms.node_baseline_p50 + ' ms.');
  console.log(lines.join('\n'));
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exitCode = 1; });
