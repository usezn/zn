// Tests for check-public-facts.mjs: run with `node --test .github/scripts/check-public-facts.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, getPath, pinnedFiles, pyVersion, isPrerelease } from './check-public-facts.mjs';

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

test('{minor} in a text fact follows the release line', () => {
  const facts = { ...FACTS, text: [{ id: 'supported', files: ['SECURITY.md'], must: ['| {minor}.x | yes |'] }] };
  const files = { ...GOOD, 'SECURITY.md': '| 2.0.x | yes |\n' };
  const runWith = (fs) => check(facts, Object.keys(fs), (f) => {
    if (!(f in fs)) throw new Error('missing');
    return fs[f];
  });
  assert.deepEqual(runWith(files), []);
  assert.deepEqual(runWith({ ...files, 'SECURITY.md': '|  2.0.x   |\tyes |\n' }), []);
  const errs = runWith({ ...files, 'SECURITY.md': '| 1.8.x | yes |\n' });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /does not say "\| 2\.0\.x \| yes \|"/);
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

test('plugin pin differences can be reported as warnings, other differences still fail', () => {
  const facts = {
    version: { value: '2.0.0', files: [{ file: 'pkg.json', json: 'version' }], pinsExclude: ['plugins/'] },
    pluginVersion: { value: '2.0.0', files: [{ file: 'plugins/p.json', json: 'version' }], pins: ['plugins/'] },
  };
  const tree = {
    'pkg.json': '{"version":"2.0.0"}',
    'plugins/p.json': '{"version":"1.9.0"}',
    'plugins/README.md': 'npm install -g zn-gate@1.9.0',
  };
  const read = (f) => { if (!(f in tree)) throw new Error('missing'); return tree[f]; };
  assert.equal(check(facts, Object.keys(tree), read).length, 2);
  const pluginWarnings = [];
  assert.deepEqual(check(facts, Object.keys(tree), read, { pluginWarnings }), []);
  assert.equal(pluginWarnings.length, 2);
  tree['pkg.json'] = '{"version":"1.9.0"}';
  const errs = check(facts, Object.keys(tree), read, { pluginWarnings: [] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^pkg\.json \(version\): version 1\.9\.0, public-facts\.json says 2\.0\.0/);
});

test('with plugin warnings, a half-done pin or an unrelated plugin version still fails', () => {
  const facts = {
    version: { value: '2.0.0', files: [{ file: 'pkg.json', json: 'version' }], pinsExclude: ['plugins/'] },
    pluginVersion: { value: '1.9.0', files: [{ file: 'plugins/p.json', json: 'version' }, { file: 'plugins/q.json', json: 'version' }], pins: ['plugins/'] },
  };
  const tree = { 'pkg.json': '{"version":"2.0.0"}', 'plugins/p.json': '{"version":"1.9.0"}', 'plugins/q.json': '{"version":"2.0.0"}' };
  const read = (f) => { if (!(f in tree)) throw new Error('missing'); return tree[f]; };
  let pluginWarnings = [];
  let errs = check(facts, Object.keys(tree), read, { pluginWarnings });
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.match(errs[0], /plugin manifests disagree on the version \(1\.9\.0, 2\.0\.0\)/);
  assert.equal(pluginWarnings.length, 1);
  tree['plugins/p.json'] = '{"version":"1.7.0"}';
  tree['plugins/q.json'] = '{"version":"1.7.0"}';
  pluginWarnings = [];
  errs = check(facts, Object.keys(tree), read, { pluginWarnings });
  assert.equal(errs.length, 2, errs.join('\n'));
  assert.equal(pluginWarnings.length, 0);
});

// Pre-releases: the release branch of 1.14.0-rc.1 keeps docs and examples on the last published release.
const RC = {
  version: {
    value: '2.1.0-rc.1',
    files: [
      { file: 'pkg/package.json', json: 'version' },
      { file: 'py/pyproject.toml', regex: '^version = "([^"]+)"', python: true },
    ],
    pinsExclude: ['CHANGELOG.md'],
  },
  docsVersion: { value: '2.0.0' },
  examplesVersion: {
    value: '2.0.0',
    files: [
      { file: 'examples/py/requirements.txt', regex: '^zn-gate==(\\S+)$', python: true },
      { file: 'examples/js/package.json', json: 'dependencies.zn-gate' },
    ],
  },
  text: [{ id: 'supported versions', files: ['SECURITY.md'], must: ['| {minor}.x |'] }],
};

const RC_GOOD = {
  'pkg/package.json': JSON.stringify({ version: '2.1.0-rc.1' }),
  'py/pyproject.toml': '[project]\nversion = "2.1.0rc1"\n',
  'examples/py/requirements.txt': 'zn-gate==2.0.0\n',
  'examples/js/package.json': JSON.stringify({ dependencies: { 'zn-gate': '2.0.0' } }),
  'README.md': 'Install: npx -y zn-gate@2.0.0 init\n',
  'SECURITY.md': '| 2.0.x | yes |\n',
};

const runWith = (facts, files) => check(facts, Object.keys(files), (f) => {
  if (!(f in files)) throw new Error('missing');
  return files[f];
});

test('pyVersion and isPrerelease', () => {
  assert.equal(pyVersion('1.14.0-rc.1'), '1.14.0rc1');
  assert.equal(pyVersion('1.14.0-alpha.2'), '1.14.0a2');
  assert.equal(pyVersion('1.14.0-beta.3'), '1.14.0b3');
  assert.equal(pyVersion('1.14.0'), '1.14.0');
  assert.equal(isPrerelease('1.14.0-rc.1'), true);
  assert.equal(isPrerelease('1.14.0'), false);
});

test('a pre-release branch is consistent: PyPI form, docs and SECURITY on the last final, examples published', () => {
  assert.deepEqual(runWith(RC, RC_GOOD), []);
});

test('on a pre-release, the Python files must carry the PyPI form', () => {
  const errs = runWith(RC, { ...RC_GOOD, 'py/pyproject.toml': '[project]\nversion = "2.1.0-rc.1"\n' });
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.match(errs[0], /py\/pyproject\.toml: version 2\.1\.0-rc\.1, public-facts\.json says 2\.1\.0rc1/);
});

test('on a pre-release, docs pins and {minor} follow docsVersion, not the pre-release', () => {
  const errs = runWith(RC, { ...RC_GOOD, 'README.md': 'npx -y zn-gate@2.1.0-rc.1 init\n', 'SECURITY.md': '| 2.1.x | yes |\n' });
  assert.equal(errs.length, 2, errs.join('\n'));
  assert.match(errs.join('\n'), /README\.md:1: pins zn-gate@2\.1\.0-rc\.1, public-facts\.json docsVersion says 2\.0\.0/);
  assert.match(errs.join('\n'), /SECURITY\.md: does not say "\| 2\.0\.x \|"/);
});

test('a pre-release without docsVersion fails with the reason', () => {
  const { docsVersion, ...noDocs } = RC;
  const errs = runWith(noDocs, RC_GOOD);
  assert.match(errs.join('\n'), /2\.1\.0-rc\.1 is a pre-release, so docsVersion .* is required/);
});

test('the examples follow examplesVersion, in the PyPI form for requirements', () => {
  const published = { ...RC, examplesVersion: { ...RC.examplesVersion, value: '2.1.0-rc.1' } };
  const files = {
    ...RC_GOOD,
    'examples/py/requirements.txt': 'zn-gate==2.1.0rc1\n',
    'examples/js/package.json': JSON.stringify({ dependencies: { 'zn-gate': '2.1.0-rc.1' } }),
  };
  assert.deepEqual(runWith(published, files), []);
  const errs = runWith(RC, files);
  assert.equal(errs.length, 2, errs.join('\n'));
  assert.match(errs.join('\n'), /examples\/py\/requirements\.txt: version 2\.1\.0rc1, public-facts\.json examplesVersion says 2\.0\.0/);
});

test('on a final release docsVersion is not used', () => {
  const final = { ...RC, version: { ...RC.version, value: '2.1.0' }, docsVersion: { value: '2.0.0' } };
  const files = {
    ...RC_GOOD,
    'pkg/package.json': JSON.stringify({ version: '2.1.0' }),
    'py/pyproject.toml': '[project]\nversion = "2.1.0"\n',
    'README.md': 'npx -y zn-gate@2.1.0 init\n',
    'SECURITY.md': '| 2.1.x | yes |\n',
  };
  assert.deepEqual(runWith(final, files), []);
});
