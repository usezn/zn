import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { pin } = require('./pin-readme-links.js');
const script = path.join(here, 'pin-readme-links.js');
const root = path.resolve(here, '..', '..');

test('blob/main and tree/main links point to the tag; other links stay', () => {
  const src = [
    '[compat](https://github.com/usezn/zn/blob/main/docs/compat.md#claude-code)',
    '[examples](https://github.com/usezn/zn/tree/main/examples/langchain-js)',
    '[issues](https://github.com/usezn/zn/issues) [site](https://usezn.com/docs/) [other](https://github.com/other/zn/blob/main/x.md)',
  ].join('\n');
  const { text, count } = pin(src, 'v1.15.0');
  assert.equal(count, 2);
  assert.match(text, /usezn\/zn\/blob\/v1\.15\.0\/docs\/compat\.md#claude-code/);
  assert.match(text, /usezn\/zn\/tree\/v1\.15\.0\/examples\/langchain-js/);
  assert.match(text, /usezn\/zn\/issues/);
  assert.match(text, /other\/zn\/blob\/main\/x\.md/);
});

test('release candidates are valid tags; anything else is refused', () => {
  assert.equal(pin('https://github.com/usezn/zn/blob/main/a.md', 'v1.15.0-rc.1').count, 1);
  for (const bad of ['main', '1.15.0', 'v1.15', 'v1.15.0; rm', '']) assert.throws(() => pin('x', bad), /not a release tag/);
});

test('the command rewrites the files in place and refuses a bad call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pin-'));
  const f = path.join(dir, 'README.md');
  fs.writeFileSync(f, 'see https://github.com/usezn/zn/blob/main/docs/secrets.md\n');
  const ok = spawnSync(process.execPath, [script, '--tag', 'v2.0.0', f], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), 'see https://github.com/usezn/zn/blob/v2.0.0/docs/secrets.md\n');
  assert.equal(spawnSync(process.execPath, [script, f], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--tag', 'nope', f], { encoding: 'utf8' }).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('both package READMEs have only links that the pin rewrites to existing paths', () => {
  for (const rel of ['packages/zn-gate/README.md', 'packages/zn-gate-py/README.md']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const { text: out } = pin(text, 'v9.9.9');
    assert.ok(!/usezn\/zn\/(blob|tree)\/main\//.test(out), rel);
    for (const m of text.matchAll(/github\.com\/usezn\/zn\/(?:blob|tree)\/main\/([^)\s"'#?]+)/g)) {
      assert.ok(fs.existsSync(path.join(root, m[1])), `${rel}: ${m[1]} does not exist in the repository`);
    }
  }
});

test('the release build pins the READMEs before packing', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/build-release.yml'), 'utf8');
  const pinAt = wf.indexOf('pin-readme-links.js');
  assert.ok(pinAt > 0, 'build-release.yml does not run pin-readme-links.js');
  assert.ok(wf.indexOf('npm pack --ignore-scripts') > 0 && pinAt < wf.indexOf('npm pack --ignore-scripts'), 'the pin step must run before npm pack');
  assert.ok(pinAt < wf.indexOf('-m build --no-isolation packages/zn-gate-py'), 'the pin step must run before the Python build');
});
