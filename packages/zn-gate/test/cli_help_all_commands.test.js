'use strict';
// Every command documented in docs/cli.md answers `--help` with exit code 0 and a usage line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const DOCS = path.join(__dirname, '..', '..', '..', 'docs', 'cli.md');

// Commands known to miss the behaviour; remove an entry once it is fixed.
// `vault log export --help` prints its usage on stderr and exits with 2.
const KNOWN_GAPS = new Set(['vault log export']);

function documentedCommands() {
  const out = [];
  for (const line of fs.readFileSync(DOCS, 'utf8').split('\n')) {
    const h = /^#{2,4} `([a-z][a-z0-9 -]*)`\s*$/.exec(line);
    if (h) out.push(h[1]);
  }
  return out;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-help-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('the command list is read from docs/cli.md', () => {
  const cmds = documentedCommands();
  assert.ok(cmds.length > 40);
  for (const c of ['init', 'scan', 'secret set', 'vault verify', 'team join']) assert.ok(cmds.includes(c), c);
});

for (const command of documentedCommands()) {
  test(`zn-gate ${command} --help exits 0 and prints a usage line`, { skip: KNOWN_GAPS.has(command) }, () => {
    const r = spawnSync(process.execPath, [CLI, ...command.split(' '), '--help'], {
      encoding: 'utf8',
      input: '',
      timeout: 20000,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      cwd: home,
    });
    assert.equal(r.status, 0, `exit code ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /^\s*usage:/im, 'no usage line on stdout');
  });
}
