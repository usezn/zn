'use strict';

process.env.ZN_STATS = 'off';

// A home folder with an accent can be spelled composed (NFC) or decomposed (NFD): macOS reports
// the second and treats both as one folder. zn's own state stays protected in every pairing.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const NAME = 'Jos\u00e9 P\u00e9rez';
const NFC = NAME.normalize('NFC');
const NFD = NAME.normalize('NFD');
const TARGETS = ['.zn/run/session.key', '.zn/vault/secrets.age', '.zn/audit.jsonl'];

test('the two spellings really differ', () => {
  assert.notEqual(NFC, NFD);
});

for (const [homeName, pathName, label] of [[NFD, NFC, 'NFD home, NFC path'], [NFC, NFD, 'NFC home, NFD path'], [NFC, NFC, 'NFC both'], [NFD, NFD, 'NFD both']]) {
  test('zn state is refused: ' + label, () => {
    const home = '/home/' + homeName;
    const missed = [];
    for (const t of TARGETS) {
      const p = '/home/' + pathName + '/' + t;
      for (const cmd of ['cat "' + p + '"', 'cat ' + p.replace(/ /g, '\\ '), 'cp "' + p + '" /work/out']) {
        if (!policy.bashDenial(cmd, { cwd: '/work/proj', home, env: {} })) missed.push(cmd);
      }
      const c = policy.classifyPath(p, { cwd: '/work/proj', home, env: {} });
      if (!c || c.kind !== 'zn_state') missed.push('classifyPath ' + p);
    }
    assert.deepEqual(missed, []);
  });
}

test('plain ASCII homes and unrelated folders are unchanged', () => {
  const o = { cwd: '/work/proj', home: '/home/jane', env: {} };
  assert.ok(policy.bashDenial('cat /home/jane/.zn/run/session.key', o));
  assert.equal(policy.bashDenial('cat /home/jane/notes/todo.txt', o), null);
  const u = { cwd: '/work/proj', home: '/home/' + NFD, env: {} };
  assert.equal(policy.bashDenial('cat "/home/' + NFC + '/notes/todo.txt"', u), null);
});
