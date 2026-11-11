'use strict';
// zn-gate status names the real source of the cloud engine: ZN_CLOUD=1 with an API key in the environment,
// or the marker that `zn-gate connect` leaves in config.json. Each test uses a temporary home.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// A made-up key, built at run time so no secret scanner reads it as a real one.
const FAKE_KEY = ['fake', 'key', 'for', 'label', 'test', '0001'].join('-');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-engine-label-'));
  try {
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function activeEngineLine(home, extraEnv) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  delete env.ZN_API_KEY;
  delete env.ZN_CLOUD;
  delete env.ZN_LOCAL_ONLY;
  delete env.NO_COLOR;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const line = r.stdout.replace(ANSI, '').split('\n').find((l) => l.includes('Active Engine'));
  assert.ok(line, 'no Active Engine line in:\n' + r.stdout);
  return line;
}

test('status: marker from zn-gate connect and ZN_CLOUD unset labels the marker, not ZN_CLOUD=1', () => {
  withHome((home) => {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.zn', 'config.json'),
      JSON.stringify({ cloud: { store: 'keychain', connectedAt: '2026-11-01T00:00:00.000Z', last4: FAKE_KEY.slice(-4) } })
    );
    const line = activeEngineLine(home, {});
    assert.match(line, /Local rules \+ cloud for analyze_prompt \(zn-gate connect marker\)/);
    assert.doesNotMatch(line, /ZN_CLOUD/);
  });
});

test('status: ZN_CLOUD=1 with an API key in the environment labels the environment', () => {
  withHome((home) => {
    const line = activeEngineLine(home, { ZN_API_KEY: FAKE_KEY, ZN_CLOUD: '1' });
    assert.match(line, /Local rules \+ cloud for analyze_prompt \(ZN_CLOUD=1 with an API key\)/);
    assert.doesNotMatch(line, /zn-gate connect/);
  });
});
