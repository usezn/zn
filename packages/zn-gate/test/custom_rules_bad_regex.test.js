'use strict';

// A bad regex in .znrules or zn.config.json skips only that rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../lib/rules');

function inDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-badre-'));
  const cwd = process.cwd();
  const origWrite = process.stderr.write;
  let err = '';
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  process.chdir(dir);
  process.stderr.write = (c) => { err += c; return true; };
  try {
    rules.loadCustomConfig(true);
    return fn(() => err);
  } finally {
    process.stderr.write = origWrite;
    process.chdir(cwd);
    rules.loadCustomConfig(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('.znrules: an invalid line before a valid pattern still blocks, and warns', () => {
  inDir({ '.znrules': '# c\n(unclosed\nforbidden-word-xyz\npath:/secret-zone\nstrict\n' }, (err) => {
    const cfg = rules.loadCustomConfig();
    assert.equal(cfg.strict, true);
    assert.deepEqual(cfg.forbiddenPaths, ['/secret-zone']);
    assert.equal(rules.evaluate('please run forbidden-word-xyz now').verdict, 'block');
    assert.match(err(), /\.znrules line 2: invalid regular expression "\(unclosed"/);
  });
});

test('.znrules: invalid line without strict is skipped and strict stays off', () => {
  inDir({ '.znrules': '[bad\nkeepme-abc\n' }, (err) => {
    const cfg = rules.loadCustomConfig();
    assert.equal(cfg.strict, false);
    assert.equal(rules.evaluate('keepme-abc').verdict, 'block');
    assert.equal(rules.evaluate('[bad').verdict, 'allow');
    assert.match(err(), /line 1.*skipped/);
  });
});

test('strict: an invalid rule is enforced as literal text', () => {
  inDir({ '.znrules': 'strict\nrm -rf (\n' }, () => {
    assert.equal(rules.evaluate('echo rm -rf ( hello').verdict, 'block');
  });
});

test('zn.config.json: one bad pattern keeps the others, paths and strict', () => {
  const cfg = JSON.stringify({ bannedPatterns: ['(oops', 'goodpat-123'], forbiddenPaths: ['/zone'], strict: true });
  inDir({ 'zn.config.json': cfg }, (err) => {
    const c = rules.loadCustomConfig();
    assert.equal(c.strict, true);
    assert.deepEqual(c.forbiddenPaths, ['/zone']);
    assert.equal(rules.evaluate('goodpat-123').verdict, 'block');
    assert.match(err(), /zn\.config\.json bannedPatterns\[0\]: invalid regular expression "\(oops"/);
  });
});
