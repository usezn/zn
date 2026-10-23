'use strict';
// zn vault purge: reset keeps a backup, purge is the separate operation that deletes everything
// (vault, token maps, backups, session key) after listing it, and checks that nothing is left.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = ['HOME', 'USERPROFILE', 'ZN_HOME', 'ZN_KEYCHAIN_BACKEND'];
const store = require('../lib/vault/store');
const keychain = require('../lib/vault/keychain');
const reset = require('../lib/vault/reset');
const purge = require('../lib/vault/purge');
const policy = require('../lib/hooks/policy');
const teamPolicy = require('../lib/team/policy');

const MAP = 'b'.repeat(32) + '.age';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-purge-'));
  const znHome = path.join(home, '.zn');
  const saved = {};
  const env = { HOME: home, USERPROFILE: home, ZN_HOME: znHome, ZN_KEYCHAIN_BACKEND: 'passphrase' };
  for (const k of ENV) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  t.after(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const put = (rel, body) => { const f = path.join(znHome, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body || 'x'); return f; };
  return {
    znHome,
    put,
    /** A locked vault with a token map, an audit log, a session key and two old backups. */
    fill(backend) {
      const meta = { v: 1, backend: backend || 'passphrase', recipient: 'age1' + 'q'.repeat(58), created: '2026-01-01T00:00:00.000Z' };
      put(path.join('vault', 'keychain.json'), JSON.stringify(meta));
      put(path.join('vault', 'secrets.age'), 'encrypted secrets and approvals');
      put(path.join('vault', 'identity.age'), 'encrypted identity');
      put(path.join('vault', MAP), 'token map');
      put('audit.jsonl', '{}\n');
      put(path.join('run', 'session.key'), 'session key');
      put(path.join('vault-backup-20260101-100000', 'vault', 'secrets.age'), 'old secrets');
      put(path.join('vault-backup-20260101-100000', 'vault', MAP), 'old token map');
      put(path.join('vault-backup-20260102-100000', 'audit.jsonl'), 'old audit');
    },
    left: () => fs.readdirSync(znHome),
  };
}

const person = (extra) => Object.assign({ stdin: { isTTY: true }, env: {}, ancestry: () => null, out: () => {} }, extra);
const tree = (dir) => {
  const acc = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else acc.push(path.relative(dir, f)); } };
  walk(dir);
  return acc.sort();
};

test('reset keeps a backup, says where, and points to purge for deleting it', async (t) => {
  const s = setup(t);
  s.fill();
  const said = [];
  assert.equal(await reset.resetVault({}, person({ ask: async () => reset.PHRASE, out: (l) => said.push(l) })), 0);
  const backups = s.left().filter((n) => n.startsWith('vault-backup-'));
  assert.equal(backups.length, 3, 'the two old backups stay and a new one is added');
  assert.match(said.join('\n'), /vault-backup-/);
  assert.match(said.join('\n'), /vault purge/);
});

test('purge refuses without a terminal and changes nothing', async (t) => {
  const s = setup(t);
  s.fill();
  const before = tree(s.znHome);
  await assert.rejects(purge.purgeVault({}, person({ stdin: { isTTY: false } })), /interactive terminal/);
  assert.deepEqual(tree(s.znHome), before);
});

test('purge refuses an AI agent, also with --yes, and changes nothing', async (t) => {
  const s = setup(t);
  s.fill();
  const before = tree(s.znHome);
  for (const yes of [false, true]) {
    await assert.rejects(purge.purgeVault({ yes }, person({ env: { CLAUDECODE: '1' } })), /not by an AI agent/);
    await assert.rejects(purge.purgeVault({ yes }, person({ ancestry: () => 'claude' })), /not by an AI agent/);
  }
  assert.deepEqual(tree(s.znHome), before);
});

test('a wrong phrase changes nothing', async (t) => {
  const s = setup(t);
  s.fill();
  const before = tree(s.znHome);
  assert.equal(await purge.purgeVault({}, person({ ask: async () => reset.PHRASE })), 1);
  assert.deepEqual(tree(s.znHome), before);
});

test('purge lists every file, deletes them all after the phrase, and finds nothing left', async (t) => {
  const s = setup(t);
  s.fill();
  const before = tree(s.znHome);
  const said = [];
  let asked = '';
  assert.equal(await purge.purgeVault({}, person({ ask: async (q) => { asked = q; return ' Purge My Vault '; }, out: (l) => said.push(l) })), 0);
  const text = said.join('\n');
  for (const rel of before) assert.ok(text.includes(path.join(s.znHome, rel)), rel + ' is listed before it is deleted');
  assert.match(text, /backup \(vault-backup-20260101-100000\)/);
  assert.match(text, /token map of a project/);
  assert.match(text, /session key/);
  assert.match(text, /secrets and first-use approvals/);
  assert.match(asked, /type "purge my vault"/);
  assert.match(text, /Purged: \d+ files deleted/);
  assert.deepEqual(s.left().filter((n) => /^vault-backup-/.test(n) || n === 'vault' || n === 'audit.jsonl' || n === 'run'), []);
  assert.equal(keychain.readMeta({}), null);
  assert.equal(purge.targets({}).files.length, 0);
});

test('--yes lets a script purge without a terminal or a phrase', async (t) => {
  const s = setup(t);
  s.fill();
  const said = [];
  assert.equal(await purge.purgeVault({ yes: true }, person({ stdin: { isTTY: false }, out: (l) => said.push(l) })), 0);
  assert.equal(purge.targets({}).files.length, 0);
  assert.equal(s.left().some((n) => n.startsWith('vault-backup-')), false);
  assert.match(said.join('\n'), /Purged:/);
});

test('with no vault there is nothing to purge', async (t) => {
  setup(t);
  const said = [];
  assert.equal(await purge.purgeVault({}, person({ ask: async () => purge.PHRASE, out: (l) => said.push(l) })), 0);
  assert.match(said.join('\n'), /no vault here to purge/);
});

test('a file that cannot be deleted is reported, the key is kept and purge does not say it is done', async (t) => {
  const s = setup(t);
  s.fill('macos');
  const stuck = path.join(s.znHome, 'vault-backup-20260101-100000', 'vault', 'secrets.age');
  const orig = fs.unlinkSync;
  const removed = [];
  keychain._native.macos.remove = () => { removed.push('macos'); return true; };
  t.after(() => { fs.unlinkSync = orig; });
  fs.unlinkSync = (f) => { if (f === stuck) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return orig(f); };
  const said = [];
  assert.equal(await purge.purgeVault({}, person({ ask: async () => purge.PHRASE, out: (l) => said.push(l) })), 1);
  fs.unlinkSync = orig;
  const text = said.join('\n');
  assert.match(text, /NOT fully purged/);
  assert.ok(text.includes(stuck));
  assert.doesNotMatch(text, /Purged:/);
  assert.deepEqual(removed, [], 'the keychain key stays while files remain');
  assert.match(text, /key in your system keychain was kept/);
});

test('a keychain that keeps the key is not reported as purged', async (t) => {
  const s = setup(t);
  s.fill('macos');
  keychain._native.macos.remove = () => false;
  keychain._native.macos.load = () => 'AGE-SECRET-KEY-1' + 'Q'.repeat(10);
  const said = [];
  assert.equal(await purge.purgeVault({}, person({ ask: async () => purge.PHRASE, out: (l) => said.push(l) })), 1);
  const text = said.join('\n');
  assert.match(text, /could not be removed from your macos keychain/);
  assert.doesNotMatch(text, /Purged:/);
});

test('inside a Team organization purge refuses and changes nothing', async (t) => {
  const s = setup(t);
  s.fill();
  const f = teamPolicy.paths({});
  fs.mkdirSync(path.dirname(f.teamFile), { recursive: true });
  fs.writeFileSync(f.teamFile, '{}');
  const before = tree(s.znHome);
  assert.equal(await purge.purgeVault({ yes: true }, person({})), 1);
  assert.deepEqual(tree(s.znHome), before);
});

test('the hooks stop an agent from running zn vault purge', () => {
  const OPTS = { cwd: os.tmpdir(), home: os.tmpdir(), env: {} };
  for (const cmd of ['zn vault purge', 'zn vault purge --yes', 'npx -y zn-gate vault purge', 'cd x && zn-gate  vault   purge --yes']) {
    assert.equal(policy.adminCommand(cmd), 'vault purge', cmd);
    assert.match(policy.bashDenial(cmd, OPTS), /own terminal/, cmd);
  }
  assert.equal(policy.adminCommand('echo vault purge'), null);
});

test('the vault CLI knows purge and rejects stray words', () => {
  const cli = require('../lib/vault/cli');
  assert.ok(cli, 'module loads');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vault', 'cli.js'), 'utf8');
  assert.match(src, /sub === 'purge'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'bin', 'cli.js'), 'utf8'), /vault purge /);
  assert.equal(typeof store.paths, 'function');
});

// --- links are never followed, the second look, a damaged settings file ---

/** A folder outside zn's home with files and a subfolder: what a link must never let purge reach. */
function victimDir(s) {
  const v = fs.mkdtempSync(path.join(path.dirname(s.znHome), 'victim-'));
  fs.mkdirSync(path.join(v, 'sub'));
  fs.writeFileSync(path.join(v, 'important.txt'), 'mine');
  fs.writeFileSync(path.join(v, 'sub', 'deep.txt'), 'mine too');
  return v;
}

test('purge: ~/.zn/run as a link is deleted and never followed: the folder it points to stays intact', async (t) => {
  const s = setup(t);
  s.fill();
  const v = victimDir(s);
  const before = tree(v);
  fs.rmSync(path.join(s.znHome, 'run'), { recursive: true });
  fs.symlinkSync(v, path.join(s.znHome, 'run'), 'junction');
  assert.ok(purge.targets().files.some((f) => f.path === path.join(s.znHome, 'run')), 'the link itself is listed');
  assert.ok(!purge.targets().files.some((f) => f.path.startsWith(v)), 'nothing inside the target is listed');
  assert.equal(await purge.purgeVault({ yes: true }, person()), 0);
  assert.deepEqual(tree(v), before, 'the target folder is untouched');
  assert.equal(fs.existsSync(path.join(s.znHome, 'run')), false, 'the link is gone');
});

test('purge: ~/.zn/vault as a link is deleted and never followed or read', async (t) => {
  const s = setup(t);
  s.fill();
  const v = victimDir(s);
  fs.writeFileSync(path.join(v, 'secrets.age'), 'not zn data');
  fs.writeFileSync(path.join(v, MAP), 'not a token map');
  fs.writeFileSync(path.join(v, 'keychain.json'), JSON.stringify({ v: 1, backend: 'libsecret', recipient: 'age1' + 'q'.repeat(58) }));
  const before = tree(v);
  fs.rmSync(path.join(s.znHome, 'vault'), { recursive: true });
  fs.symlinkSync(v, path.join(s.znHome, 'vault'), 'junction');
  const tg = purge.targets();
  assert.ok(tg.files.some((f) => f.path === path.join(s.znHome, 'vault')), 'the link itself is listed');
  assert.ok(!tg.files.some((f) => f.path.startsWith(v)), 'nothing inside the target is listed');
  assert.equal(tg.backend, null, 'the settings file behind the link is not read');
  assert.equal(await purge.purgeVault({ yes: true }, person()), 0);
  assert.deepEqual(tree(v), before, 'the target folder is untouched');
  assert.equal(fs.existsSync(path.join(s.znHome, 'vault')), false, 'the link is gone');
});

test('purge: inside run only the first level goes, and a real subfolder is never entered', async (t) => {
  const s = setup(t);
  s.fill();
  s.put(path.join('run', 'daemon.sock'), 'x');
  s.put(path.join('run', 'sub', 'keep.txt'), 'not zn files');
  const names = purge.targets().files.map((f) => path.basename(f.path));
  assert.ok(names.includes('daemon.sock') && names.includes('session.key'));
  assert.ok(!names.includes('keep.txt'));
});

test('purge: a file whose folder resolves outside zn is never deleted', async (t) => {
  const s = setup(t);
  s.fill();
  const v = victimDir(s);
  // A folder swapped for a link after the listing: the check before each delete refuses it.
  fs.rmSync(path.join(s.znHome, 'run'), { recursive: true });
  fs.symlinkSync(v, path.join(s.znHome, 'run'), 'junction');
  const homeReal = fs.realpathSync(s.znHome);
  assert.equal(purge._unlinkGone(path.join(s.znHome, 'run', 'important.txt'), homeReal), false);
  assert.equal(fs.readFileSync(path.join(v, 'important.txt'), 'utf8'), 'mine');
  assert.equal(purge._unlinkGone(path.join(s.znHome, 'audit.jsonl'), homeReal), true, 'a file inside zn goes');
});

test('purge: a delete that reports success while the file stays is caught by the second look', async (t) => {
  const s = setup(t);
  s.fill();
  const key = path.join(s.znHome, 'run', 'session.key');
  const real = fs.unlinkSync;
  fs.unlinkSync = (f) => (f === key ? undefined : real(f));
  t.after(() => { fs.unlinkSync = real; });
  const r = await purge.removeAll();
  assert.ok(r.left.includes(key), 'a file still on disk is reported as left');
  assert.ok(!r.removed.includes(key));
  let said = '';
  assert.equal(await purge.purgeVault({ yes: true }, person({ out: (l) => { said += l + '\n'; } })), 1);
  assert.match(said, /NOT fully purged/);
});

test('purge: a damaged keychain.json does not hide a keychain entry that may remain', async (t) => {
  const s = setup(t);
  s.fill();
  fs.writeFileSync(path.join(s.znHome, 'vault', 'keychain.json'), '{not json');
  process.env.ZN_KEYCHAIN_BACKEND = 'libsecret';
  const native = keychain._native.libsecret;
  let removed = 0;
  keychain._native.libsecret = { load: () => 'AGE-SECRET-KEY-1' + 'Q'.repeat(20), remove: () => { removed++; } };
  t.after(() => { keychain._native.libsecret = native; });
  assert.equal(purge.targets().probe, 'libsecret');
  let said = '';
  assert.equal(await purge.purgeVault({ yes: true }, person({ out: (l) => { said += l + '\n'; } })), 0);
  assert.match(said, /libsecret keychain still holds a "zn" entry/);
  assert.equal(removed, 0, 'an entry zn cannot tie to this vault is reported, not deleted');
  assert.equal(fs.existsSync(path.join(s.znHome, 'vault', 'secrets.age')), false, 'the files are still purged');
});
