'use strict';
// Every environment variable listed in the Settings tables of docs/cli.md must be read somewhere in the
// code under lib/ or bin/. A comment, a message string or an assignment (process.env.X = ...) does not
// count: only a real read such as env.X, env['X'], or env[NAME] where NAME holds 'X'.
// So a documented setting cannot disappear from the code without this test failing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const repo = path.resolve(pkgRoot, '..', '..');
const cliDoc = path.join(repo, 'docs', 'cli.md');

// The settings this test was written for. The parser must find each of them in the tables.
const EXPECTED = ['ZN_CLOUD', 'ZN_LOCAL_ONLY', 'ZN_STAGE', 'ZN_API_URL', 'ZN_STATS', 'ZN_VERBOSE', 'NO_COLOR'];

/** The text of the "## Settings" section, up to its "### All environment variables" part. */
function settingsSection(md) {
  const start = md.indexOf('\n## Settings\n');
  assert.ok(start >= 0, 'docs/cli.md has a "## Settings" section');
  const rest = md.slice(start + 1);
  const ends = [rest.indexOf('\n### All environment variables'), rest.indexOf('\n## ', 3)].filter((i) => i > 0);
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
}

/** Environment variable names in the first cell of each table row of the section. */
function documentedVariables(section) {
  const names = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const first = line.split('|')[1] || '';
    for (const m of first.matchAll(/`([A-Z][A-Z0-9_]*)(?:=[^`]*)?`/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Source without block comments and without line comments (a // after a colon, as in a URL, is kept). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:\\'"])\/\/.*$/, '$1'))
    .join('\n');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the source reads the variable (not only assigns it). */
function readsVariable(src, name) {
  const notAssigned = '(?!\\s*=(?!=))';
  const direct = new RegExp('\\benv\\)?\\s*(?:\\.' + esc(name) + '\\b|\\[\\s*([\'"`])' + esc(name) + '\\1\\s*\\])' + notAssigned);
  if (direct.test(src)) return true;
  // const SOME_NAME = 'X'; ... env[SOME_NAME]
  for (const m of src.matchAll(new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*([\'"])' + esc(name) + '\\2', 'g'))) {
    if (new RegExp('\\benv\\)?\\s*\\[\\s*' + esc(m[1]) + '\\s*\\]' + notAssigned).test(src)) return true;
  }
  return false;
}

function codeSources() {
  const files = [...jsFiles(path.join(pkgRoot, 'lib')), ...jsFiles(path.join(pkgRoot, 'bin'))];
  return files.map((f) => ({ file: path.relative(pkgRoot, f), src: stripComments(fs.readFileSync(f, 'utf8')) }));
}

const present = fs.existsSync(cliDoc);

test('the scanner counts reads and ignores comments, strings and assignments', () => {
  const read = (code) => readsVariable(stripComments(code), 'ZN_EXAMPLE_SETTING');
  assert.equal(read('const on = process.env.ZN_EXAMPLE_SETTING === "1";'), true);
  assert.equal(read('if (env.ZN_EXAMPLE_SETTING) run();'), true);
  assert.equal(read("const v = (opts.env || process.env)['ZN_EXAMPLE_SETTING'];"), true);
  assert.equal(read("const K = 'ZN_EXAMPLE_SETTING'; const v = (io.env || process.env)[K];"), true);
  assert.equal(read('// reads process.env.ZN_EXAMPLE_SETTING'), false);
  assert.equal(read('/* env.ZN_EXAMPLE_SETTING */'), false);
  assert.equal(read("const msg = 'set ZN_EXAMPLE_SETTING=1 to turn it on';"), false);
  assert.equal(read("process.env.ZN_EXAMPLE_SETTING = 'off';"), false);
  assert.equal(read('const v = process.env.ZN_EXAMPLE_SETTING_OTHER;'), false);
});

test('the Settings tables of docs/cli.md list the expected variables', { skip: !present && 'docs/cli.md not found' }, () => {
  const names = documentedVariables(settingsSection(fs.readFileSync(cliDoc, 'utf8')));
  for (const name of EXPECTED) assert.ok(names.includes(name), name + ' is listed in the Settings tables of docs/cli.md');
});

test('every variable in the Settings tables of docs/cli.md is read by code under lib/ or bin/', { skip: !present && 'docs/cli.md not found' }, () => {
  const names = documentedVariables(settingsSection(fs.readFileSync(cliDoc, 'utf8')));
  const sources = codeSources();
  const missing = names.filter((name) => !sources.some(({ src }) => readsVariable(src, name)));
  assert.deepEqual(missing, [], 'documented in docs/cli.md Settings but not read under lib/ or bin/: ' + missing.join(', '));
});

for (const name of EXPECTED) {
  test(name + ' is read by code under lib/ or bin/', { skip: !present && 'docs/cli.md not found' }, () => {
    const readers = codeSources().filter(({ src }) => readsVariable(src, name)).map(({ file }) => file);
    assert.ok(readers.length > 0, name + ' is documented but no file under lib/ or bin/ reads it');
  });
}
