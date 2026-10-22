'use strict';

// -V and --version are a version request only before the command; the Python package follows the same rule
// (packages/zn-gate-py/tests/test_version_flag_position.py runs the same corpus).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

// [arguments, exit code, kind of output]
const CORPUS = [
  [['-V'], 0, 'version'],
  [['--version'], 0, 'version'],
  [['-V', 'scan', '.'], 0, 'version'],
  [['--version', 'status'], 0, 'version'],
  [['scan', '.', '-V'], 2, 'unknown option'],
  [['status', '--version'], 2, 'unknown option'],
];

test('a version flag counts only before the command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vflag-'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  try {
    for (const [args, code, kind] of CORPUS) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8' });
      const label = args.join(' ');
      assert.equal(r.status, code, label);
      if (kind === 'version') assert.match(r.stdout, /^zn-gate \d+\.\d+\.\d+/, label);
      else {
        assert.equal(r.stdout, '', label);
        assert.match(r.stderr, /unknown option/i, label);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
