'use strict';
// zn-gate config: allowlisted keys, validated values, atomic write, other keys kept.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function homeWith(t, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (config !== undefined) {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return home;
}

function zn(home, ...args) {
  return spawnSync(process.execPath, [CLI, 'config', ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ZN_STATS: 'off', NO_COLOR: '1' }),
  });
}

const cfgFile = (home) => path.join(home, '.zn', 'config.json');
const readCfg = (home) => JSON.parse(fs.readFileSync(cfgFile(home), 'utf8'));

test('set then get round trip, with no file at the start', (t) => {
  const home = homeWith(t);
  assert.strictEqual(zn(home, 'get', 'hooks.stopReview').stdout, 'warn\n');
  const s = zn(home, 'set', 'hooks.stopReview', 'block');
  assert.strictEqual(s.status, 0, s.stderr);
  assert.strictEqual(zn(home, 'get', 'hooks.stopReview').stdout, 'block\n');
  assert.deepStrictEqual(readCfg(home), { hooks: { stopReview: 'block' } });
});

test('an invalid value is refused with exit 2 and nothing is written', (t) => {
  const home = homeWith(t, { hooks: { stopReview: 'block' } });
  const r = zn(home, 'set', 'hooks.stopReview', 'yes please');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /not a value of hooks\.stopReview/);
  assert.deepStrictEqual(readCfg(home), { hooks: { stopReview: 'block' } });
});

test('an unknown key is refused with exit 2', (t) => {
  const home = homeWith(t);
  for (const args of [['set', 'hooks.whenUnavailable', 'allow'], ['get', 'nope'], ['set', '__proto__.x', 'block']]) {
    const r = zn(home, ...args);
    assert.strictEqual(r.status, 2, args.join(' '));
  }
  assert.ok(!fs.existsSync(cfgFile(home)));
});

test('other keys and sections of the file are kept', (t) => {
  const home = homeWith(t, { team: { id: 'x' }, hooks: { whenUnavailable: 'deny' }, extra: [1, 2] });
  assert.strictEqual(zn(home, 'set', 'hooks.stopReview', 'block').status, 0);
  assert.deepStrictEqual(readCfg(home), { team: { id: 'x' }, hooks: { whenUnavailable: 'deny', stopReview: 'block' }, extra: [1, 2] });
});

test('a file that is not valid JSON is not overwritten', (t) => {
  const home = homeWith(t, '{ not json');
  const r = zn(home, 'set', 'hooks.stopReview', 'block');
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(cfgFile(home), 'utf8'), '{ not json');
});

test('making zn less strict needs a terminal; making it stricter does not', (t) => {
  const home = homeWith(t, { hooks: { stopReview: 'block' } });
  const r = zn(home, 'set', 'hooks.stopReview', 'warn');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /your own terminal/);
  assert.strictEqual(readCfg(home).hooks.stopReview, 'block');
});

test('replaceToolOutputOnSecret is stored as a boolean', (t) => {
  const home = homeWith(t);
  assert.strictEqual(zn(home, 'set', 'hooks.replaceToolOutputOnSecret', 'true').status, 0);
  assert.strictEqual(readCfg(home).hooks.replaceToolOutputOnSecret, true);
  assert.strictEqual(zn(home, 'get', 'hooks.replaceToolOutputOnSecret').stdout, 'true\n');
});

test('the file mode is kept and no temp file stays behind', { skip: process.platform === 'win32' }, (t) => {
  const home = homeWith(t, { a: 1 });
  fs.chmodSync(cfgFile(home), 0o640);
  assert.strictEqual(zn(home, 'set', 'hooks.stopReview', 'block').status, 0);
  assert.strictEqual(fs.statSync(cfgFile(home)).mode & 0o777, 0o640);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, '.zn')), ['config.json']);
});

test('list shows each key with its value and marks defaults', (t) => {
  const home = homeWith(t, { hooks: { stopReview: 'block' } });
  const r = zn(home, 'list');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /hooks\.stopReview = block\n/);
  assert.match(r.stdout, /hooks\.replaceToolOutputOnSecret = false \(default\)/);
});

test('wrong usage exits 2', (t) => {
  const home = homeWith(t);
  for (const args of [[], ['get'], ['set', 'hooks.stopReview'], ['list', 'x'], ['frob']]) {
    assert.strictEqual(zn(home, ...args).status, 2, args.join(' '));
  }
});

test('the stop-review notice points to the command', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js'), 'utf8');
  assert.match(src, /zn-gate config set hooks\.stopReview block/);
  assert.doesNotMatch(src, /set "stopReview" to "block" under "hooks"/);
});
