'use strict';
// ZN_HOME moves the whole zn state: the evidence ledger follows it, like stats, pins and the vault. The hook config there
// can only add protection: settings that relax a check come from the operating-system account's home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib');

const PRELOAD = path.resolve(__dirname, 'helpers', 'account_home_preload.js');

function run(script, env) {
  const base = { ...process.env };
  delete base.ZN_HOME;
  const r = spawnSync(process.execPath, ['-r', PRELOAD, '-e', script], { encoding: 'utf8', env: { ...base, ZN_LIB: LIB, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-home-everywhere-')); }
const USERPROFILE_KEYS = (h) => ({ HOME: h, USERPROFILE: h });

test('evidence ledger lives in ZN_HOME when it is set', () => {
  const fakeHome = tmp(); const znHome = tmp();
  const out = run("const e=require(require('path').join(process.env.ZN_LIB,'evidence'));console.log(e.EVIDENCE_FILE)",
    { ...USERPROFILE_KEYS(fakeHome), ZN_HOME: znHome });
  assert.equal(out, path.join(path.resolve(znHome), 'evidence.jsonl'));
});

test('logEvidence writes the default ledger under ZN_HOME and nothing under ~/.zn', () => {
  const fakeHome = tmp(); const znHome = tmp();
  run("const e=require(require('path').join(process.env.ZN_LIB,'evidence'));e.logEvidence({agent:'t',payload:'x',verdict:'allow'})",
    { ...USERPROFILE_KEYS(fakeHome), ZN_HOME: znHome });
  assert.ok(fs.existsSync(path.join(znHome, 'evidence.jsonl')));
  assert.ok(!fs.existsSync(path.join(fakeHome, '.zn', 'evidence.jsonl')));
});

test('without ZN_HOME the ledger stays in ~/.zn', () => {
  const fakeHome = tmp();
  const out = run("const e=require(require('path').join(process.env.ZN_LIB,'evidence'));console.log(e.EVIDENCE_FILE)", USERPROFILE_KEYS(fakeHome));
  assert.equal(out, path.join(fakeHome, '.zn', 'evidence.jsonl'));
});

test('hook config in ZN_HOME can only add protection', () => {
  const fakeHome = tmp(); const znHome = tmp(); const account = tmp();
  fs.writeFileSync(path.join(znHome, 'config.json'), JSON.stringify({ hooks: { whenUnavailable: 'allow', egressCheck: 'deny' } }));
  const out = run("const r=require(require('path').join(process.env.ZN_LIB,'hooks','runner'));console.log(JSON.stringify(r.readConfig()))",
    { ...USERPROFILE_KEYS(fakeHome), ZN_HOME: znHome, ZN_TEST_ACCOUNT_HOME: account });
  assert.deepEqual(JSON.parse(out), { hooks: { egressCheck: 'deny' } });
});

test('hook config without ZN_HOME is read from the account home ~/.zn', () => {
  const fakeHome = tmp();
  fs.mkdirSync(path.join(fakeHome, '.zn'));
  fs.writeFileSync(path.join(fakeHome, '.zn', 'config.json'), JSON.stringify({ hooks: { failMode: 'open' } }));
  const out = run("const r=require(require('path').join(process.env.ZN_LIB,'hooks','runner'));console.log(JSON.stringify(r.readConfig()))",
    { ...USERPROFILE_KEYS(fakeHome), ZN_TEST_ACCOUNT_HOME: fakeHome });
  assert.deepEqual(JSON.parse(out), { hooks: { failMode: 'open' } });
});
