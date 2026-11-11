// Tests of check-security-advisory-links.mjs. Run: node --test .github/scripts/check-security-advisory-links.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anchorsOf, checkLinks, slugOf } from './check-security-advisory-links.mjs';

const ADVISORY = [
  '# SEC-1: Title `code` & more!',
  '',
  '## Fix',
  '',
  '```md',
  '## Not a heading',
  '```',
  '',
  '## Fix',
  '',
].join('\n');

/* Runs checkLinks on a SECURITY.md text with the given repository files (path -> text). */
function run(security, files = { 'docs/advisories/SEC-1.md': ADVISORY }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'advlinks-'));
  for (const name of Object.keys(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), files[name]);
  }
  const read = (rel) => {
    const p = path.join(dir, rel);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  };
  return checkLinks(security, { read });
}

test('heading slugs follow GitHub: code marks and punctuation go, spaces become hyphens', () => {
  assert.equal(slugOf('SEC-1: Title `code` & more!'), 'sec-1-title-code--more');
  assert.equal(slugOf('Fix [the link](https://example.com) now'), 'fix-the-link-now');
});

test('repeated headings get -1, -2 suffixes and code blocks have no headings', () => {
  const a = anchorsOf(ADVISORY);
  assert.ok(a.has('fix'));
  assert.ok(a.has('fix-1'));
  assert.ok(!a.has('not-a-heading'));
});

test('links to existing files and existing anchors pass', () => {
  const r = run([
    '[a](docs/advisories/SEC-1.md)',
    '[b](./docs/advisories/SEC-1.md#fix-1)',
    '[c](docs/advisories/SEC-1.md#sec-1-title-code--more)',
    '[d](https://github.com/usezn/zn/blob/main/docs/advisories/SEC-1.md#fix)',
  ].join('\n'));
  assert.equal(r.links, 4);
  assert.deepEqual(r.problems, []);
});

test('a missing file and a missing anchor are reported with their line', () => {
  const r = run('intro\n[gone](docs/advisories/SEC-9.md)\n[bad](docs/advisories/SEC-1.md#nope)\n');
  assert.deepEqual(r.problems.map((p) => p.line), [2, 3]);
  assert.match(r.problems[0].reason, /no file docs\/advisories\/SEC-9\.md/);
  assert.match(r.problems[1].reason, /#nope/);
});

test('reference definitions and blob links are checked too', () => {
  const r = run('[ref]: docs/advisories/SEC-9.md\n[ok]: docs/advisories/SEC-1.md\n[x](https://github.com/usezn/zn/blob/main/docs/advisories/SEC-8.md)\n');
  assert.equal(r.links, 3);
  assert.deepEqual(r.problems.map((p) => p.line), [1, 3]);
});

test('other links, same-page anchors and links inside code blocks are ignored', () => {
  const r = run([
    '[other](docs/team.md)',
    '[ext](https://example.com/docs/advisories/SEC-9.md)',
    '[same](#reporting)',
    '```md',
    '[code](docs/advisories/SEC-9.md)',
    '```',
  ].join('\n'));
  assert.equal(r.links, 0);
  assert.deepEqual(r.problems, []);
});

test('an encoded target is decoded before the file lookup', () => {
  const r = run('[a](docs/advisories/SEC%2D1.md)', { 'docs/advisories/SEC-1.md': ADVISORY });
  assert.deepEqual(r.problems, []);
});
