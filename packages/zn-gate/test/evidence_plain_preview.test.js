'use strict';
// A hook block appends one record with _plainPreview: the ledger must not load the redaction engine
// for it (that cost about 17 ms per block). Without _plainPreview the preview is still redacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

function run(script, dir) {
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, ZN_LIB: LIB, ZN_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('an append with _plainPreview loads neither the rules nor the scrubber engine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-plain-'));
  try {
    const out = run(`
      const path = require('path');
      const ev = require(path.join(process.env.ZN_LIB, 'evidence'));
      const payload = JSON.stringify({ event: 'pre_tool', tool: 'Bash', kinds: [] });
      const rec = ev.logEvidence({ agent: 'claude-code', phase: 'hook-pre_tool', tool_name: 'Bash', payload, verdict: 'block' },
        path.join(process.env.ZN_DIR, 'evidence.jsonl'), { lockWaitMs: 500, noStats: true, _plainPreview: true });
      const loaded = Object.keys(require.cache).map((k) => path.relative(process.env.ZN_LIB, k));
      process.stdout.write(JSON.stringify({ preview: rec.payload_preview, payload, loaded }));
    `, dir);
    assert.equal(out.preview, out.payload);
    assert.ok(!out.loaded.includes('rules.js'), out.loaded.join(', '));
    assert.ok(!out.loaded.some((m) => m.startsWith('scrub')), out.loaded.join(', '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without _plainPreview the preview is still redacted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-plain-'));
  try {
    // Fake key, built in pieces.
    const key = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const out = run(`
      const path = require('path');
      const ev = require(path.join(process.env.ZN_LIB, 'evidence'));
      const rec = ev.logEvidence({ agent: 'test', payload: 'token ${key}' }, path.join(process.env.ZN_DIR, 'evidence.jsonl'), { noStats: true });
      process.stdout.write(JSON.stringify({ preview: rec.payload_preview }));
    `, dir);
    assert.ok(!out.preview.includes(key.slice(4)), out.preview);
    assert.match(out.preview, /REDACTED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
