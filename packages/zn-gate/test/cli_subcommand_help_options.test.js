'use strict';
// The per-command help pages (lib/cli-help.js) against the general help and against the Python CLI.
// Option names only: the pages must not invent options, must not mix the options of another command,
// and the options both packages have must agree.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HELP } = require('../lib/cli-help');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const PY_SRC = path.join(__dirname, '..', '..', 'zn-gate-py', 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-helpopts-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const ENV = { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true', NO_COLOR: '1' };
function node(words) {
  return spawnSync(process.execPath, [CLI, ...words], { encoding: 'utf8', input: '', timeout: 20000, env: ENV });
}
const options = (text) => new Set(text.match(/--[a-z][a-z-]*/g) || []);

const COMMANDS = ['scan', 'evidence', 'stats', 'check', 'analyze', 'status', 'test', 'report', 'pins', 'why', 'init', 'run', 'connect', 'disconnect'];
const general = node(['--help']).stdout;
const generalOptions = options(general);

test('each command prints its own short page, exit 0, on stdout only', () => {
  for (const c of [...COMMANDS, 'logs']) {
    const r = node([c, '--help']);
    assert.strictEqual(r.status, 0, c);
    assert.strictEqual(r.stderr, '', c);
    assert.ok(r.stdout.length < general.length / 2, c + ' page is not short');
    assert.ok(r.stdout.startsWith('usage: zn-gate '), c);
  }
});

test('a page lists only options that the general help knows (it cannot drift)', () => {
  for (const c of COMMANDS) {
    for (const o of options(HELP[c].join('\n'))) {
      assert.ok(generalOptions.has(o) || o === '--help', c + ' page has ' + o + ' that the general help does not');
    }
  }
});

test('a page does not mention options that belong only to other commands', () => {
  const ownOf = {};
  for (const c of COMMANDS) ownOf[c] = options(HELP[c].join('\n'));
  for (const c of COMMANDS) {
    const text = node([c, '--help']).stdout;
    const got = options(text);
    const elsewhere = new Set();
    for (const [other, set] of Object.entries(ownOf)) if (other !== c) for (const o of set) elsewhere.add(o);
    for (const o of got) {
      if (ownOf[c].has(o)) continue;
      assert.ok(!elsewhere.has(o), c + ' page mentions ' + o + ' of another command');
    }
    for (const o of ownOf[c]) assert.ok(got.has(o), c + ' output lacks ' + o);
  }
});

test('commands with options show a default or say they take none, and an example', () => {
  assert.match(node(['scan', '--help']).stdout, /text \(default\)/);
  assert.match(node(['stats', '--help']).stdout, /default 30/);
  assert.match(node(['report', '--help']).stdout, /default 7d/);
  assert.match(node(['evidence', '--help']).stdout, /default 20/);
  assert.match(node(['test', '--help']).stdout, /takes no options/);
  for (const c of COMMANDS) assert.match(node([c, '--help']).stdout, /\nExample: zn-gate /, c);
});

// Python commands whose help exists in both packages. Differences that docs/cli.md lists on purpose.
const KNOWN_PYTHON_ONLY = { scan: ['--no-fail'], test: ['--json'] };
const PY_COMMANDS = ['test', 'analyze', 'scan', 'evidence', 'status', 'stats', 'check'];
const py = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
const hasPython = py.status === 0 && fs.existsSync(path.join(PY_SRC, 'zn_gate', 'cli.py'));

test('options of the Python help are in the npm page, except the documented differences', { skip: !hasPython && 'python3 not available' }, () => {
  for (const c of PY_COMMANDS) {
    const r = spawnSync('python3', ['-m', 'zn_gate.cli', c, '--help'], {
      encoding: 'utf8', input: '', timeout: 30000, env: { ...ENV, PYTHONPATH: PY_SRC, COLUMNS: '200' },
    });
    assert.strictEqual(r.status, 0, c + ': ' + r.stderr);
    const pyOpts = options(r.stdout);
    const nodeOpts = options(HELP[c].join('\n'));
    const allowed = new Set(KNOWN_PYTHON_ONLY[c] || []);
    for (const o of pyOpts) {
      if (o === '--help') continue;
      assert.ok(nodeOpts.has(o) || allowed.has(o), c + ': Python has ' + o + ' but the npm page does not');
    }
  }
});
