'use strict';

// A cloud call that fails warns on stderr (exit code unchanged), and an altered
// evidence log makes `evidence --export` and `evidence` exit 1 like `--verify`.
// Temporary home, fake key, a port nothing listens on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-fb-'));
  fs.mkdirSync(path.join(h, '.zn'), { recursive: true });
  return h;
}

function run(h, args, extra = {}) {
  const env = { ...process.env, HOME: h, USERPROFILE: h, NO_COLOR: '1', ...extra };
  delete env.ZN_HOME;
  delete env.ZN_VERBOSE;
  if (!('ZN_CLOUD' in extra)) delete env.ZN_CLOUD;
  if (!('ZN_API_KEY' in extra)) delete env.ZN_API_KEY;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

function ledger(h, tamper) {
  const file = path.join(h, '.zn', 'evidence.jsonl');
  for (let i = 0; i < 3; i++) logEvidence({ payload: 'example-' + i, tool_name: 'bash' }, file);
  if (tamper) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rec = JSON.parse(lines[0]);
    rec.verdict = 'tampered';
    lines[0] = JSON.stringify(rec);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  }
  return file;
}

test('a valid ledger exits 0 for counts, export and verify', () => {
  const h = home();
  ledger(h, false);
  for (const args of [['evidence'], ['evidence', '--export'], ['evidence', '--verify']]) {
    assert.equal(run(h, args).status, 0, args.join(' '));
  }
});

test('an altered ledger exits 1 for export and counts, and the output is still written', () => {
  const h = home();
  ledger(h, true);
  assert.equal(run(h, ['evidence', '--verify']).status, 1);
  const exp = run(h, ['evidence', '--export']);
  assert.equal(exp.status, 1);
  assert.match(exp.stderr, /Tamper detected/);
  assert.ok(exp.stdout.trim().length > 0);
  const out = path.join(h, 'out.jsonl');
  assert.equal(run(h, ['evidence', '--export', '--output', out]).status, 1);
  assert.ok(fs.existsSync(out));
  const st = run(h, ['evidence']);
  assert.equal(st.status, 1);
  assert.match(st.stdout, /CORRUPTED/);
});

test('analyze warns on stderr when the cloud call fails and the local rules answer', () => {
  const h = home();
  const r = run(h, ['analyze', 'hello there'], {
    ZN_CLOUD: '1', ZN_API_KEY: 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2', ZN_API_URL: 'http://127.0.0.1:9/analyze',
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /the cloud call failed/);
  assert.equal(JSON.parse(r.stdout).fallback, true);
});

test('analyze with no cloud has no warning', () => {
  const r = run(home(), ['analyze', 'hello there']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
