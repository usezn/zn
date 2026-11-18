'use strict';
// Option parity with the Python package, and the root help against docs/cli.md.
//  - scan refuses the cloud options (--key, --stage, --url, --local-only, --long-input) with exit 2.
//  - status refuses options that are not its own.
//  - the root help names every command and alias that docs/cli.md documents, and every -v/--version form.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const cli = path.join(pkgRoot, 'bin', 'cli.js');
const cliDoc = path.join(pkgRoot, '..', '..', 'docs', 'cli.md');

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-parity-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_CLOUD: '', ZN_API_KEY: '' };
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, input: '', cwd: home });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const opt of [['--key', 'abc'], ['--stage', 'v30'], ['--url', 'https://example.com'], ['--local-only'], ['--long-input', 'off']]) {
  test('scan refuses ' + opt[0] + ' with exit 2', () => {
    const r = run(['scan', '.', ...opt]);
    assert.strictEqual(r.code, 2, r.out + r.err);
    assert.match(r.err, new RegExp('unknown option "' + opt[0]));
    assert.match(r.err, /The options of zn-gate scan are/);
  });
}

test('scan keeps --verbose and its own options', () => {
  const r = run(['scan', '.', '--verbose', '--format', 'json']);
  assert.notStrictEqual(r.code, 2, r.err);
});

for (const bad of ['--json', '--format', '--frob', '--long-input', '--days']) {
  test('status refuses ' + bad + ' with exit 2', () => {
    const r = run(['status', bad, 'x']);
    assert.strictEqual(r.code, 2, r.out + r.err);
    assert.match(r.err, /The options of zn-gate status are --key, --stage, --url, --local-only, --verbose/);
  });
}

test('status still takes its own options', () => {
  const r = run(['status', '--local-only', '--stage', 'v30']);
  assert.strictEqual(r.code, 0, r.err);
});

// What docs/cli.md documents: every "### `name`" heading (top level) and the "Aliases:" line under it.
function documentedNames(md) {
  const names = new Set();
  let level3 = false;
  for (const line of md.split('\n')) {
    const h = /^(#{2,4}) (.*)$/.exec(line);
    if (h) {
      level3 = h[1].length === 3;
      const m = /^`([a-z][a-z-]*)`$/.exec(h[2]);
      if (level3 && m) names.add(m[1]);
      continue;
    }
    const a = /^Aliases: (.*)$/.exec(line);
    if (a && level3) {
      for (const m of a[1].matchAll(/`([a-z][a-z-]*)`/g)) names.add(m[1]);
    }
  }
  return names;
}

test('the root help names every command and alias of docs/cli.md', () => {
  const help = run(['--help']).out;
  const names = documentedNames(fs.readFileSync(cliDoc, 'utf8'));
  assert.ok(names.size > 25, 'found only ' + names.size + ' names in docs/cli.md');
  for (const alias of ['wrap', 'export', 'secrets', 'doctor', 'logs', 'mcp-shield']) assert.ok(names.has(alias), alias + ' missing from the parse of docs/cli.md');
  const missing = [...names].filter((n) => !new RegExp('(?<![\\w-])' + n + '(?![\\w-])').test(help));
  assert.deepStrictEqual(missing, [], 'in docs/cli.md but not in the root help: ' + missing.join(', '));
});

test('the root help names -v, -V and --version', () => {
  const help = run(['--help']).out;
  for (const f of ['-v', '-V', '--version']) assert.ok(help.includes(f), f);
});
