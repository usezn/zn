'use strict';
// The order of names and timestamps in the vault listing, the vault purge list and the reach
// history must not depend on the language of the computer (B-6833: localeCompare did).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { byCode } = require('../lib/code-order');

const LOCALES = ['C', 'tr_TR.UTF-8', 'sv_SE.UTF-8', 'en_US.UTF-8'];
// Names where the Turkish dotted and dotless i and the Swedish a-ring, a-umlaut, o-umlaut and z
// are ordered differently by a locale than by code unit.
const NAMES = ['zeta', 'Zeta', 'iris', 'Iris', 'ıris', 'İris', 'z', 'ång', 'äng', 'öl', 'a_b', 'a-b', 'ab', 'B', 'a'];

function inChild(locale, code) {
  return execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, LANG: locale, LC_ALL: locale, LANGUAGE: locale },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('byCode is a plain code-unit order, ISO timestamps and ASCII names keep their order', () => {
  assert.deepEqual(['2026-01-02', '2025-12-31', '2026-01-01'].sort(byCode), ['2025-12-31', '2026-01-01', '2026-01-02']);
  assert.deepEqual(['b', 'a', 'c', 'ab'].sort(byCode), ['a', 'ab', 'b', 'c']);
  assert.deepEqual(['B', 'a'].sort(byCode), ['B', 'a']);
  assert.equal(byCode('a', 'a'), 0);
  assert.equal(byCode(undefined, undefined), 0);
});

test('the three sorts give the same order whatever the locale of the process', () => {
  const root = path.join(__dirname, '..', 'lib');
  const code = `
    const path = require('path');
    const { byCode } = require(${JSON.stringify(path.join(root, 'code-order'))});
    const purge = require(${JSON.stringify(path.join(root, 'vault', 'purge'))});
    const names = ${JSON.stringify(NAMES)};
    const files = names.map((n) => ({ kind: 'backup (' + n + ')', path: path.join('home', n, 'f') }));
    const lines = purge.describe({ files, backend: 'passphrase' }, { home: 'home' }).filter((l) => /backup made by/.test(l));
    const hist = {}; names.forEach((n, i) => { hist[n] = { at: n }; });
    const keys = Object.keys(hist).sort((a, b) => byCode(hist[a].at, hist[b].at));
    console.log(JSON.stringify({ lines, keys, sorted: names.slice().sort(byCode) }));
  `;
  const results = LOCALES.map((l) => inChild(l, code));
  for (const r of results) assert.equal(r, results[0], 'same order in every locale');
  const parsed = JSON.parse(results[0]);
  assert.deepEqual(parsed.sorted, NAMES.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(parsed.lines.length, NAMES.length);
  // Uppercase before lowercase: a locale sort would put 'a' before 'B'.
  assert.ok(parsed.keys.indexOf('B') < parsed.keys.indexOf('a'));
});

test('no sort in lib or bin uses localeCompare', () => {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (/\.(js|mjs|cjs)$/.test(e.name) && /\.localeCompare\(/.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(path.join(__dirname, '..'), p));
    }
  };
  walk(path.join(__dirname, '..', 'lib'));
  walk(path.join(__dirname, '..', 'bin'));
  assert.deepEqual(bad, []);
});
