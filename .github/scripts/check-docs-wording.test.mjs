// Tests of check-docs-wording.mjs. Run: node --test .github/scripts/check-docs-wording.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, hitsOf, proseOf } from './check-docs-wording.mjs';

test('easy, easily and simply are flagged in any case, also inside a hyphenated word', () => {
  assert.equal(hitsOf('This is easily done.\n').length, 1);
  assert.equal(hitsOf('Easy to read.\n').length, 1);
  assert.equal(hitsOf('Just SIMPLY run it.\n').length, 1);
  assert.equal(hitsOf('An easy-to-use tool.\n').length, 1);
});

test('words that only contain the letters are not flagged', () => {
  assert.deepEqual(hitsOf('It is easier, uneasily, easiest and simpler.\n'), []);
});

test('inline code, fenced code, link targets and bare URLs are not flagged', () => {
  assert.deepEqual(hitsOf('Run `easily` now.\n'), []);
  assert.deepEqual(hitsOf('```sh\nsimply run\n```\n'), []);
  assert.deepEqual(hitsOf('See [the guide](docs/easy.md).\n'), []);
  assert.deepEqual(hitsOf('Source: https://example.invalid/simply\n'), []);
});

test('link text is prose and is flagged', () => {
  assert.equal(hitsOf('[easily](x.md)\n').length, 1);
  assert.equal(proseOf('[easily](x.md)'), '[easily]');
});

test('hits carry the line number and the source line', () => {
  const [h] = hitsOf('# Title\n\nDo it easily here.\n');
  assert.equal(h.line, 3);
  assert.equal(h.word, 'easily');
  assert.equal(h.text, 'Do it easily here.');
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docwording-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('a page with the word fails and names its file; a clean tree passes', () => {
  const bad = tree({ 'a.md': 'Clean line.\n', 'sub/b.md': 'This is easily done.\n' });
  const r = checkDir(bad);
  assert.equal(r.checked, 2);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].file, 'sub/b.md');
  assert.equal(r.hits[0].line, 1);

  const clean = tree({ 'a.md': 'Run the command.\n' });
  assert.deepEqual(checkDir(clean).hits, []);
});

test('licence and notice files are not checked, their wording is verbatim', () => {
  const dir = tree({ 'NOTICE.md': 'easily\n', 'LICENSE.md': 'simply\n', 'LICENSE-MIT.md': 'easy\n', 'a.md': 'This is easily done.\n' });
  const r = checkDir(dir);
  assert.equal(r.checked, 1);
  assert.deepEqual(r.hits.map((h) => h.file), ['a.md']);
});
