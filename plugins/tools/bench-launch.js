#!/usr/bin/env node
'use strict';

/**
 * Measure what the plugin launcher adds to each hook call.
 *
 *   node plugins/tools/bench-launch.js <zn-gate package source dir> [runs]
 *
 * Packs the package with `npm pack` (its dependencies must be installed, for
 * example with `npm ci --ignore-scripts`), unpacks the tarball into a
 * temporary npm-style prefix, pins a temporary copy of the launcher to it,
 * and times, for the same PreToolUse event:
 *   - `node -e 0` (Node start-up alone),
 *   - `node lib/hooks/runner.js claude-code` (zn-gate's hook without the plugin),
 *   - `node zn-launch.js hook claude-code` (the plugin: full tree check,
 *     in-memory load, same runner).
 * Prints the median and the 90th percentile of each, and the overhead.
 * Informational: it fails only if the launcher does not answer like the runner.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const src = path.resolve(process.argv[2] || 'packages/zn-gate');
const runs = Number(process.argv[3] || 15);
const LAUNCHER = path.resolve(__dirname, '..', 'zn-gate', 'scripts', 'zn-launch.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-bench-')));

function tarEntries(buf) {
  const out = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (s, l) => h.subarray(s, s + l).toString('utf8').replace(/\0.*$/s, '');
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') out.push({ name, body });
  }
  return out;
}

function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function time(label, args, input) {
  const ms = [];
  let last;
  for (let i = 0; i < runs + 1; i++) {
    const t = process.hrtime.bigint();
    last = spawnSync(process.execPath, args, { input, encoding: 'utf8' });
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    if (i > 0) ms.push(d); // the first run warms the file cache
  }
  const r = { label, median: percentile(ms, 0.5), p90: percentile(ms, 0.9), out: last.stdout, status: last.status, err: last.stderr };
  process.stdout.write(label.padEnd(40) + ' median ' + r.median.toFixed(1).padStart(7) + ' ms   p90 ' + r.p90.toFixed(1).padStart(7) + ' ms\n');
  return r;
}

try {
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: src, encoding: 'utf8', shell: process.platform === 'win32' });
  if (pack.status !== 0) throw new Error('npm pack failed: ' + pack.stderr);
  const tgz = path.join(tmp, JSON.parse(pack.stdout)[0].filename);
  const pkgDir = path.join(tmp, 'prefix', 'zn-gate');
  const files = {};
  for (const e of tarEntries(zlib.gunzipSync(fs.readFileSync(tgz)))) {
    const rel = e.name.replace(/^package\//, '');
    const dest = path.join(pkgDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.body);
    files[rel] = crypto.createHash('sha256').update(e.body).digest('hex');
  }
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  const bytes = Object.keys(files).reduce((n, rel) => n + fs.statSync(path.join(pkgDir, ...rel.split('/'))).size, 0);

  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ plugin: { packageDir: pkgDir } }));
  const scripts = path.join(tmp, 'plugin', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'zn-launch.js'),
    fs.readFileSync(LAUNCHER, 'utf8').replace(/function homeDir\(\) \{/, 'function homeDir() { return ' + JSON.stringify(home) + ';'));
  fs.writeFileSync(path.join(scripts, 'zn-gate.lock.json'), JSON.stringify({ package: 'zn-gate', version, files }));

  process.stdout.write('zn-gate ' + version + ': ' + Object.keys(files).length + ' files, ' + (bytes / 1048576).toFixed(1) +
    ' MiB; ' + runs + ' runs each; Node.js ' + process.version + ' on ' + process.platform + '/' + process.arch + '\n');
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'bench', cwd: tmp, tool_name: 'Bash', tool_input: { command: 'ls' } });
  const base = time('node -e 0', ['-e', '0'], '');
  const direct = time('runner.js claude-code (no plugin)', [path.join(pkgDir, 'lib', 'hooks', 'runner.js'), 'claude-code'], event);
  const plugin = time('zn-launch.js hook claude-code (plugin)', [path.join(scripts, 'zn-launch.js'), 'hook', 'claude-code'], event);
  process.stdout.write('launcher overhead (median): ' + (plugin.median - direct.median).toFixed(1) + ' ms; Node start-up: ' + base.median.toFixed(1) + ' ms\n');
  if (plugin.status !== direct.status || plugin.out !== direct.out) {
    throw new Error('the launcher answered differently from the runner: ' + JSON.stringify([plugin.status, plugin.out, plugin.err, direct.status, direct.out]));
  }
} catch (err) {
  process.stderr.write('bench-launch: ' + err.message + '\n');
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
