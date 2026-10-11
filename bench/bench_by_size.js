'use strict';
// bench_by_size.js — local latency of the zn-gate rules engine by input size.
// Stdlib only, no network. Benign synthetic inputs (code-like text); the fake
// secrets used for the redaction rows are random values generated at runtime.
//
//   node bench/bench_by_size.js            # uses ../packages/zn-gate
//   node bench/bench_by_size.js <pkg_dir>  # benchmark another checkout / installed package
//
// Prints JSON with host, Node version and p50/p95/p99 in microseconds.
// Please send us your numbers (with the host line) via GitHub issues.

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PKG = path.resolve(process.argv[2] || path.join(__dirname, '..', 'packages', 'zn-gate'));
const rules = require(path.join(PKG, 'lib', 'rules.js'));

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const rnd = (n, al) => Array.from(crypto.randomBytes(n), (b) => al[b % al.length]).join('');
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const AN = AZ + 'abcdefghijklmnopqrstuvwxyz';

const code = (i) =>
  `function handler${i}(req, res) {\n  const user = await db.users.findOne({ id: req.params.id });\n` +
  `  if (!user) return res.status(404).json({ error: 'not found' });\n` +
  `  logger.info('loaded user', { id: user.id, plan: user.plan, n: ${i} });\n  return res.json(user);\n}\n`;

function doc(bytes, i, withSecrets) {
  let s = '';
  let k = 0;
  while (s.length < bytes) s += code(i * 1000 + k++);
  s = s.slice(0, bytes);
  if (withSecrets) {
    s += `\nAWS_ACCESS_KEY_ID=AKIA${rnd(16, AZ)}\nGITHUB_TOKEN=ghp_${rnd(36, AN)}\n` +
      `DATABASE_URL=postgres://app:${rnd(20, AN)}@db.internal:5432/app\n`;
  }
  return s;
}

function bench(name, fn, inputs) {
  for (let i = 0; i < 200; i++) fn(inputs[i % inputs.length] + ' w' + i); // warm-up, unique keys
  const t = [];
  for (const x of inputs) {
    const s = process.hrtime.bigint();
    fn(x);
    t.push(Number(process.hrtime.bigint() - s) / 1e3);
  }
  return { name, n: inputs.length, p50_us: +pct(t, 50).toFixed(1), p95_us: +pct(t, 95).toFixed(1), p99_us: +pct(t, 99).toFixed(1) };
}

async function mcpRoundTrip() {
  const p = spawn(process.execPath, [path.join(PKG, 'bin', 'cli.js'), 'mcp'], {
    env: { ...process.env, ZN_API_KEY: '', ZN_CLOUD: '', ZN_LOCAL_ONLY: 'true' },
  });
  let buf = '';
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(l);
        const w = waiters.get(m.id);
        if (w) w(m);
      } catch (_) {}
    }
  });
  const call = (id, method, params) =>
    new Promise((r) => {
      waiters.set(id, r);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await call(0, 'initialize', {});
  const t = [];
  for (let i = 1; i <= 300; i++) {
    const c = doc(4096, i, false);
    const s = process.hrtime.bigint();
    await call(i, 'tools/call', { name: 'check_tool_result', arguments: { tool_name: 'Read', content: c } });
    t.push(Number(process.hrtime.bigint() - s) / 1e3);
  }
  p.kill();
  return { name: 'MCP stdio check_tool_result 4KB (round-trip)', n: 300, p50_us: +pct(t, 50).toFixed(1), p95_us: +pct(t, 95).toFixed(1), p99_us: +pct(t, 99).toFixed(1) };
}

(async () => {
  let version = 'unknown';
  try {
    version = require(path.join(PKG, 'package.json')).version;
  } catch (_) {}
  const out = {
    date: new Date().toISOString().slice(0, 10),
    host: (os.cpus()[0] || {}).model || 'unknown',
    cpus: os.cpus().length,
    node: process.version,
    zn_gate: version,
    rules_version: rules.RULES_VERSION,
    results: [],
  };
  for (const size of [200, 4096, 65536]) {
    const N = size > 10000 ? 300 : 2000;
    const plain = Array.from({ length: N }, (_, i) => doc(size, i, false) + ' #' + i); // unique: cache miss
    out.results.push(bench(`evaluate() ${size}B`, (x) => rules.evaluate(x), plain));
    const sec = Array.from({ length: N }, (_, i) => doc(size, i, true) + ' #' + i);
    out.results.push(bench(`sanitizeToolResult() ${size}B + 3 fake secrets`, (x) => rules.sanitizeToolResult('Read', x), sec));
  }
  out.results.push(await mcpRoundTrip());
  console.log(JSON.stringify(out, null, 1));
})();
