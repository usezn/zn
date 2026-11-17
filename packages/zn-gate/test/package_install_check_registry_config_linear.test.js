'use strict';

process.env.ZN_STATS = 'off';

// Package install check: the project's settings files (.npmrc, pyproject.toml, uv.toml, ...) belong to whoever owns the
// repository, so reading them must stay cheap on any content. Hostile files (long runs of blank lines, spaces, line
// separators or half-written headers) are read in linear time, and real settings still give the same answer.
// The time bound is generous (seconds) next to the cost of the old patterns (minutes at the same size).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reg = require('../lib/package-registry');

const NPM_PRIVATE = 'https://npm.corp.example.invalid';
const PYPI_PRIVATE = 'https://pypi.corp.example.invalid/simple';

function project(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-regcfg-'));
  const dir = path.join(base, 'proj');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return { dir, home: path.join(base, 'nohome'), base };
}

function ask(eco, files) {
  const p = project(files);
  try {
    return reg.privateRegistry(eco, { cwd: p.dir, home: p.home, env: {} });
  } finally {
    fs.rmSync(p.base, { recursive: true, force: true });
  }
}

const NPM_FILES = ['.npmrc', '.pnpmrc', 'pnpm-workspace.yaml', '.yarnrc', '.yarnrc.yml', 'bunfig.toml'];
const PY_FILES = ['uv.toml', 'pip.conf', 'pyproject.toml'];
const BIG = 60 * 1024; // under the 64 KiB read limit, so the file is parsed whole
const HOSTILE = {
  'blank lines': '\n'.repeat(BIG),
  'blank lines with CRLF': '\r\n'.repeat(BIG / 2),
  'table opener and spaces': '[[' + ' '.repeat(BIG),
  'table opener, dots and spaces': '[[a' + ' .'.repeat(BIG / 2),
  'key and spaces': 'registry' + ' '.repeat(BIG),
  'key, equals and spaces': 'registry=' + ' '.repeat(BIG) + '\n',
  'index key and spaces': 'index-url' + ' '.repeat(BIG),
  'empty keys over blank lines': 'registry:\n'.repeat(BIG / 20) + '\n'.repeat(BIG / 2),
  'line separators': '  '.repeat(BIG / 2),
  'value with a line separator': 'a' + ' '.repeat(BIG / 2) + '=' + ' '.repeat(BIG / 4) + 'x y',
  'scoped key colons': '@a:'.repeat(BIG / 3),
};

for (const [label, body] of Object.entries(HOSTILE)) {
  test('linear: ' + label + ' is read in linear time', () => {
    const files = {};
    for (const n of NPM_FILES.concat(PY_FILES)) files[n] = body;
    for (const eco of ['npm', 'pypi']) {
      const t = process.cpuUsage();
      ask(eco, files);
      const u = process.cpuUsage(t);
      const ms = (u.user + u.system) / 1000;
      assert.ok(ms < 3000, eco + ': ' + Math.round(ms) + ' ms CPU for 9 files of ' + BIG + ' bytes');
    }
  });
}

test('linear: a file over the read limit still counts as another registry', () => {
  assert.equal(ask('npm', { '.npmrc': 'a=b\n'.repeat(30000) }), true);
  assert.equal(ask('pypi', { 'pyproject.toml': '# x\n'.repeat(30000) }), true);
});

// What real settings files say, unchanged by the rewrite.
const NPM_CASES = [
  ['public registry', { '.npmrc': 'registry=https://registry.npmjs.org/\n' }, false],
  ['public registry on yarnpkg', { '.npmrc': 'registry = "https://registry.yarnpkg.com"\n' }, false],
  ['only auth and flags', { '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nsave-exact=true\n' }, false],
  ['private registry', { '.npmrc': 'registry=' + NPM_PRIVATE + '\n' }, true],
  ['private registry after comments and blanks', { '.npmrc': '# corp\n\n\n  registry = ' + NPM_PRIVATE + '/\n' }, true],
  ['private registry, CRLF', { '.npmrc': 'save-exact=true\r\nregistry=' + NPM_PRIVATE + '\r\n' }, true],
  ['scoped registry', { '.npmrc': '@corp:registry=' + NPM_PRIVATE + '\n' }, true],
  ['scoped public registry', { '.npmrc': '@corp:registry=https://registry.npmjs.org\n' }, false],
  ['pnpmrc', { '.pnpmrc': 'registry=' + NPM_PRIVATE + '\n' }, true],
  ['yarn v1', { '.yarnrc': 'registry "' + NPM_PRIVATE + '"\n' }, true],
  ['yarn v1 public', { '.yarnrc': 'registry "https://registry.yarnpkg.com"\n' }, false],
  ['yarn berry server', { '.yarnrc.yml': 'npmRegistryServer: "' + NPM_PRIVATE + '"\n' }, true],
  ['yarn berry public server', { '.yarnrc.yml': "npmRegistryServer: 'https://registry.yarnpkg.com'\n" }, false],
  ['yarn berry scopes', { '.yarnrc.yml': 'npmScopes:\n  corp:\n    npmRegistryServer: x\n' }, true],
  ['pnpm workspace registry', { 'pnpm-workspace.yaml': 'packages:\n  - a\nregistry: ' + NPM_PRIVATE + '\n' }, true],
  ['pnpm workspace registries map', { 'pnpm-workspace.yaml': 'registries:\n  default: x\n' }, true],
  ['pnpm workspace value on the next line', { 'pnpm-workspace.yaml': 'registry:\n  ' + NPM_PRIVATE + '\n' }, true],
  ['pnpm workspace public registry', { 'pnpm-workspace.yaml': 'registry: https://registry.npmjs.org\n' }, false],
  ['bunfig', { 'bunfig.toml': '[install]\nregistry = "' + NPM_PRIVATE + '"\n' }, true],
  ['no settings', {}, false],
];
for (const [label, files, want] of NPM_CASES) {
  test('legit npm settings: ' + label, () => assert.equal(ask('npm', files), want));
}

const PY_CASES = [
  ['no settings', {}, false],
  ['pip.conf index-url', { 'pip.conf': '[global]\nindex-url = ' + PYPI_PRIVATE + '\n' }, true],
  ['pip.conf extra index', { 'pip.conf': '[global]\n  extra-index-url=' + PYPI_PRIVATE + '\n' }, true],
  ['pip.conf without an index', { 'pip.conf': '[global]\ntimeout = 60\n' }, false],
  ['uv.toml index-url key (any value is treated as another index)', { 'uv.toml': 'index-url = "https://pypi.org/simple"\n' }, true],
  ['uv.toml private index-url', { 'uv.toml': 'index-url = "' + PYPI_PRIVATE + '"\n' }, true],
  ['uv.toml index table, private', { 'uv.toml': '[[index]]\nname = "corp"\nurl = "' + PYPI_PRIVATE + '"\n' }, true],
  ['uv.toml index table, public', { 'uv.toml': '[[index]]\nname = "pypi"\nurl = "https://pypi.org/simple"\n' }, false],
  ['uv.toml pip table with find-links', { 'uv.toml': '[pip]\nfind-links = ["x"]\n' }, true],
  ['uv.toml other keys', { 'uv.toml': 'python-preference = "managed"\n[pip]\nsystem = true\n' }, false],
  ['pyproject uv index', { 'pyproject.toml': '[project]\nname = "a"\n\n[[tool.uv.index]]\nname = "c"\nurl = "' + PYPI_PRIVATE + '"\n' }, true],
  ['pyproject uv index with spaces in the header', { 'pyproject.toml': '[[ tool . uv . index ]]\nurl = "' + PYPI_PRIVATE + '"\n' }, true],
  ['pyproject uv index with quotes in the header', { 'pyproject.toml': '[["tool"."uv"."index"]]\nurl = "' + PYPI_PRIVATE + '"\n' }, true],
  ['pyproject uv index, public', { 'pyproject.toml': '[[tool.uv.index]]\nurl = "https://pypi.org/simple"\n' }, false],
  ['pyproject poetry source', { 'pyproject.toml': '[[tool.poetry.source]]\nname = "c"\nurl = "' + PYPI_PRIVATE + '"\n' }, true],
  ['pyproject pdm source', { 'pyproject.toml': '[[tool.pdm.source]]\nurl = "' + PYPI_PRIVATE + '"\n' }, true],
  ['pyproject tool.uv index-url', { 'pyproject.toml': '[tool.uv]\nindex-url = "' + PYPI_PRIVATE + '"\n' }, true],
  ['pyproject index-url key (any value is treated as another index)', { 'pyproject.toml': '[tool.uv]\nindex-url = "https://pypi.org/simple"\n' }, true],
  ['pyproject index-url outside a uv table', { 'pyproject.toml': '[tool.other]\nindex-url = "x"\n' }, true],
  ['pyproject, CRLF, comments', { 'pyproject.toml': '# top\r\n[project]\r\nname = "a"\r\n[tool.uv]\r\n# c\r\nextra-index-url = ["x"]\r\n' }, true],
  ['pyproject without an index', { 'pyproject.toml': '[project]\nname = "a"\ndependencies = ["requests"]\n[tool.ruff]\nline-length = 100\n' }, false],
  ['pyproject header without a closing bracket', { 'pyproject.toml': '[tool.uv\nindex-url = "x"\n' }, true],
];
for (const [label, files, want] of PY_CASES) {
  test('legit python settings: ' + label, () => assert.equal(ask('pypi', files), want));
}
