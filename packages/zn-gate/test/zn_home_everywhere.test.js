'use strict';
// ZN_HOME moves the whole zn state: the evidence ledger and the hook config follow it, like stats, pins and the vault.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib');

function run(script, env) {
  const base = { ...process.env };
  delete base.ZN_HOME;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...base, ZN_LIB: LIB, ...env } });
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

test('hook config is read from ZN_HOME, as cloud-key and pins do', () => {
  const fakeHome = tmp(); const znHome = tmp();
  fs.writeFileSync(path.join(znHome, 'config.json'), JSON.stringify({ hooks: { whenUnavailable: 'allow' } }));
  const out = run("const r=require(require('path').join(process.env.ZN_LIB,'hooks','runner'));console.log(JSON.stringify(r.readConfig()))",
    { ...USERPROFILE_KEYS(fakeHome), ZN_HOME: znHome });
  assert.deepEqual(JSON.parse(out), { hooks: { whenUnavailable: 'allow' } });
});

test('hook config without ZN_HOME is still read from ~/.zn', () => {
  const fakeHome = tmp();
  fs.mkdirSync(path.join(fakeHome, '.zn'));
  fs.writeFileSync(path.join(fakeHome, '.zn', 'config.json'), JSON.stringify({ hooks: { failMode: 'open' } }));
  const out = run("const r=require(require('path').join(process.env.ZN_LIB,'hooks','runner'));console.log(JSON.stringify(r.readConfig()))", USERPROFILE_KEYS(fakeHome));
  assert.deepEqual(JSON.parse(out), { hooks: { failMode: 'open' } });
});
