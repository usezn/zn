'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isVerbose, debugEnabled, znHome } = require('../lib/env');
const { humanError } = require('../lib/errors');
const { ZnError, CODES } = require('../lib/errors');

test('ZN_VERBOSE: one rule', () => {
  for (const v of ['1', 'true', 'TRUE', 'Yes', 'on', ' On ']) assert.equal(isVerbose({ ZN_VERBOSE: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) assert.equal(isVerbose({ ZN_VERBOSE: v }), false, String(v));
  assert.equal(debugEnabled({ DEBUG: '1' }), true);
  assert.equal(debugEnabled({ ZN_VERBOSE: '0' }), false);
});

test('ZN_HOME redirects the evidence log, stats and the home resolver alike', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-home-parity-'));
  assert.equal(znHome({ ZN_HOME: home }), path.resolve(home));
  const code = "const e=require('../lib/evidence');const s=require('../lib/stats');" +
    "e.logEvidence({agent:'test',phase:'pre_tool',verdict:'allow',tool_name:'t'});" +
    "console.log(JSON.stringify([e.EVIDENCE_FILE,s.statsFile?s.statsFile():null]))";
  const r = spawnSync(process.execPath, ['-e', code], { cwd: __dirname, env: { ...process.env, ZN_HOME: home, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'zn-fake-')), USERPROFILE: home + '-x' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [ev] = JSON.parse(r.stdout.trim());
  assert.equal(ev, path.join(path.resolve(home), 'evidence.jsonl'));
  assert.ok(fs.existsSync(ev), 'evidence written under ZN_HOME');
  fs.rmSync(home, { recursive: true, force: true });
});
