'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const FAKE_KEY = 'zn_fake_key_for_tests_0123456789';

function runStatus(t, extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const name of ['ZN_CLOUD', 'ZN_API_KEY', 'ZN_LOCAL_ONLY', 'ZN_STAGE', 'ZN_ENDPOINT']) {
    if (!(name in extra)) delete env[name];
  }
  const r = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env });
  return { r, out: r.stdout + r.stderr };
}

test('status with nothing set reports local rules only and exits 0', (t) => {
  const { r, out } = runStatus(t, {});
  assert.strictEqual(r.status, 0);
  assert.match(out, /Active Engine\s+: Local rules only/);
  assert.match(out, /Endpoint\s+: None \(nothing leaves this machine\)/);
  assert.match(out, /API key\s+: Not set/);
  assert.match(out, /Leaves machine\s+: Nothing/);
});

test('status with ZN_CLOUD=1 and a key reports the cloud and never prints the key', (t) => {
  const { r, out } = runStatus(t, { ZN_CLOUD: '1', ZN_API_KEY: FAKE_KEY });
  assert.strictEqual(r.status, 0);
  assert.match(out, /Active Engine\s+: Local rules \+ cloud for analyze_prompt/);
  assert.match(out, /API key\s+: Set \(ZN_API_KEY\)/);
  assert.match(out, /Leaves machine\s+: analyze_prompt text only/);
  assert.doesNotMatch(out, /Endpoint\s+: None/);
  assert.ok(!out.includes(FAKE_KEY));
  assert.ok(!out.includes(FAKE_KEY.slice(-8)));
});

test('status with ZN_LOCAL_ONLY=true stays local even with ZN_CLOUD=1 and a key', (t) => {
  const { r, out } = runStatus(t, { ZN_LOCAL_ONLY: 'true', ZN_CLOUD: '1', ZN_API_KEY: FAKE_KEY });
  assert.strictEqual(r.status, 0);
  assert.match(out, /Active Engine\s+: Local rules only/);
  assert.match(out, /Endpoint\s+: None \(nothing leaves this machine\)/);
  assert.match(out, /unused: cloud requires ZN_CLOUD=1/);
  assert.match(out, /Leaves machine\s+: Nothing/);
  assert.ok(!out.includes(FAKE_KEY));
});

test('the cloud line differs between the three states', (t) => {
  const line = (extra) => runStatus(t, extra).out.split('\n').find((l) => l.includes('Active Engine'));
  const none = line({});
  const cloud = line({ ZN_CLOUD: '1', ZN_API_KEY: FAKE_KEY });
  const localOnly = line({ ZN_LOCAL_ONLY: 'true' });
  assert.notStrictEqual(none, cloud);
  assert.notStrictEqual(localOnly, cloud);
});
