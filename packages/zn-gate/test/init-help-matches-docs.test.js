'use strict';
// `zn-gate init --help` names every flag that docs/cli.md documents for `init`.
// The flags are read from the init section of docs/cli.md; the help text must mention each one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const CLI = path.join(pkgRoot, 'bin', 'cli.js');

// The init section: from its heading to the next "### " heading (uninstall).
function initSection() {
  const md = fs.readFileSync(path.join(repoRoot, 'docs', 'cli.md'), 'utf8');
  const start = md.indexOf('\n### `init`\n');
  assert.ok(start >= 0, 'docs/cli.md has an init section');
  const next = md.indexOf('\n### ', start + 1);
  return md.slice(start, next < 0 ? undefined : next);
}

function documentedFlags() {
  return Array.from(new Set(initSection().match(/--[a-z][a-z-]*/g) || [])).sort();
}

function isolatedEnv(home) {
  return {
    PATH: process.env.PATH || '',
    HOME: home,
    USERPROFILE: home,
    ZN_HOME: path.join(home, '.zn'),
    TMPDIR: home,
    NO_COLOR: '1',
    ZN_STATS: 'off',
    ZN_LOCAL_ONLY: 'true',
  };
}

test('docs/cli.md documents the four init flags this test pins down', () => {
  assert.deepStrictEqual(documentedFlags(), ['--dry-run', '--revert', '--shadow', '--wrap-mcp']);
});

test('zn-gate init --help mentions every flag documented for init in docs/cli.md', () => {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-b5067-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'init', '--help'], {
      encoding: 'utf8',
      input: '',
      timeout: 30000,
      env: isolatedEnv(home),
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const flags = documentedFlags();
    assert.ok(flags.length > 0, 'the init section lists flags');
    for (const flag of flags) {
      assert.ok(r.stdout.includes(flag), 'init --help should mention ' + flag);
    }
    assert.match(r.stdout, /init --wrap-mcp\s+Find and wrap the MCP servers/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
