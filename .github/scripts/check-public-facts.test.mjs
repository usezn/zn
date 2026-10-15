// Tests for check-public-facts.mjs: run with `node --test .github/scripts/check-public-facts.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, getPath, pinnedFiles } from './check-public-facts.mjs';

const FACTS = {
  version: {
    value: '2.0.0',
    files: [
      { file: 'pkg/package.json', json: 'version' },
      { file: 'pkg/server.json', json: 'packages.0.version' },
      { file: 'py/pyproject.toml', regex: '^version = "([^"]+)"' },
    ],
    pinsExclude: ['CHANGELOG.md', 'pkg/test/'],
    allowPins: [{ file: 'docs/old.md', pin: 'zn-gate@1.0.0' }],
  },
  text: [{ id: 'agents', files: ['README.md'], must: ['Claude Code, Cursor'], forbid: ['Hermes'] }],
  fields: [{ id: 'license', value: 'MIT', files: [{ file: 'pkg/package.json', json: 'license' }] }],
};

const GOOD = {
  'pkg/package.json': JSON.stringify({ version: '2.0.0', license: 'MIT' }),
  'pkg/server.json': JSON.stringify({ packages: [{ version: '2.0.0' }] }),
  'py/pyproject.toml': '[project]\nname = "x"\nversion = "2.0.0"\n',
  'README.md': 'Works with Claude Code, Cursor.\n\n    npx -y zn-gate@2.0.0 init\n',
  'docs/old.md': 'Attestations: npm view zn-gate@1.0.0 dist.attestations\n',
  'CHANGELOG.md': 'zn-gate@1.0.0 was the first release\n',
  'pkg/test/a.json': '{"cmd": "npx zn-gate@0.1.0"}',
  'pkg/index.js': 'zn-gate@0.0.1 in code is not checked',
};

const run = (files) => check(FACTS, Object.keys(files), (f) => {
  if (!(f in files)) throw new Error('missing');
  return files[f];
});

test('a consistent repository has no differences', () => {
  assert.deepEqual(run(GOOD), []);
});

test('a manifest with another version is reported', () => {
  const errs = run({ ...GOOD, 'pkg/server.json': JSON.stringify({ packages: [{ version: '1.9.0' }] }) });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /pkg\/server\.json \(packages\.0\.version\): version 1\.9\.0, public-facts\.json says 2\.0\.0/);
});

test('a missing version is reported, not ignored', () => {
  const errs = run({ ...GOOD, 'py/pyproject.toml': '[project]\nname = "x"\n' });
  assert.match(errs.join('\n'), /py\/pyproject\.toml: version not found/);
});

test('pinned references in docs must match, with their line', () => {
  const errs = run({ ...GOOD, 'README.md': GOOD['README.md'] + '\nSee https://github.com/usezn/zn/blob/v1.9.0/docs/compat.md\nusezn/zn@v1.9.0 and --ref v1.9.0\n' });
  assert.equal(errs.length, 3, errs.join('\n'));
  assert.match(errs[0], /^README\.md:\d+: pins /);
});

test('excluded paths, code files and allowed pins are not checked', () => {
  assert.deepEqual(pinnedFiles(Object.keys(GOOD), FACTS.version.pinsExclude).sort(), ['README.md', 'docs/old.md', 'pkg/package.json', 'pkg/server.json']);
  const errs = run({ ...GOOD, 'docs/old.md': 'npm view zn-gate@1.0.1 dist.attestations\n' });
  assert.equal(errs.length, 1, 'only the allowed exact pin passes');
});

test('required and forbidden text', () => {
  const errs = run({ ...GOOD, 'README.md': 'Works with Claude Code and Hermes.\n' });
  assert.equal(errs.length, 2);
  assert.match(errs.join('\n'), /does not say "Claude Code, Cursor"/);
  assert.match(errs.join('\n'), /says "Hermes"/);
});

test('field values and missing files', () => {
  const files = { ...GOOD, 'pkg/package.json': JSON.stringify({ version: '2.0.0', license: 'ISC' }) };
  assert.match(run(files).join('\n'), /license is ISC, public-facts\.json says MIT/);
  const { ['README.md']: _, ...noReadme } = GOOD;
  assert.match(run(noReadme).join('\n'), /README\.md: file not found/);
});

test('getPath reads array indexes', () => {
  assert.equal(getPath({ a: [{ b: 1 }] }, 'a.0.b'), 1);
  assert.equal(getPath({}, 'a.0.b'), undefined);
});

test('the version in prose is checked too', () => {
  const prose = 'It installs zn-gate 1.9.0, pins zn-gate **1.9.0**, needs exactly version 1.9.0 and the `v1.9.0` tag.\n';
  const errs = run({ ...GOOD, 'README.md': GOOD['README.md'] + prose });
  assert.equal(errs.length, 4, errs.join('\n'));
  assert.deepEqual(run({ ...GOOD, 'README.md': GOOD['README.md'] + prose.replace(/1\.9\.0/g, '2.0.0') }), []);
});

test('the plugin follows its own version (pluginVersion)', () => {
  const facts = {
    version: { value: '2.0.0', files: [{ file: 'pkg.json', json: 'version' }], pinsExclude: ['plugins/'] },
    pluginVersion: { value: '1.9.0', files: [{ file: 'plugins/p.json', json: 'version' }], pins: ['plugins/'] },
  };
  const tree = {
    'pkg.json': '{"version":"2.0.0"}',
    'plugins/p.json': '{"version":"1.9.0"}',
    'plugins/README.md': 'npm install -g zn-gate@1.9.0',
    'README.md': 'npm install -g zn-gate@2.0.0',
  };
  const read = (f) => { if (!(f in tree)) throw new Error('missing'); return tree[f]; };
  assert.deepEqual(check(facts, Object.keys(tree), read), []);
  tree['plugins/README.md'] = 'npm install -g zn-gate@2.0.0';
  const errs = check(facts, Object.keys(tree), read);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /plugins\/README\.md:1: pins zn-gate@2\.0\.0, public-facts\.json pluginVersion says 1\.9\.0/);
  tree['plugins/README.md'] = 'npm install -g zn-gate@1.9.0';
  tree['plugins/p.json'] = '{"version":"2.0.0"}';
  assert.match(check(facts, Object.keys(tree), read)[0], /plugins\/p\.json \(version\): version 2\.0\.0, public-facts\.json pluginVersion says 1\.9\.0/);
});
