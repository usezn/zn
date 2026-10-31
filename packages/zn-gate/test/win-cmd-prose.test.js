'use strict';
/* On Windows only commands change (inline code and `manual:` steps); ordinary sentences stay byte for byte. */

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { winCommandText, winManualText } = require('../lib/zn-command');
const { guide } = require('../lib/init-guide');
const { tempDir } = require('./helpers/tmp');

const PROSE = [
  'each agent\'s zn hook whether the agent may read them',
  'so Claude Code runs no zn check before tool calls',
  'the zn hook in <file> was modified',
  'while the zn hooks next to it',
  'no other zn hook protects ZCode',
  'zn-gate check: does zn stop your coding agent from reading a secret?',
  'zn-gate check did not report it',
  'zn checks tool calls before they run; the zn-gate plugin is kept',
  'Ask the user to run npx -y zn-gate@1.14.1 env shadow .env',
];

async function asPlatformAsync(value, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

test('prose is byte-identical on win32, also with commands in backticks next to it', () => {
  for (const p of PROSE) {
    assert.equal(winCommandText(p, 'win32'), p);
    assert.equal(winCommandText(p + ' Then run `zn hooks install codex`.', 'win32'), p + ' Then run `zn.cmd hooks install codex`.');
  }
});

test('commands inside backticks become zn.cmd, zn-gate.cmd and npx.cmd', () => {
  assert.equal(
    winCommandText('Run `npx -y zn-gate init`, then `zn hooks install codex` and `zn-gate check`; a zn check runs.', 'win32'),
    'Run `npx.cmd -y zn-gate init`, then `zn.cmd hooks install codex` and `zn-gate.cmd check`; a zn check runs.'
  );
  assert.equal(winCommandText('`zn.cmd hooks install x` `npx.cmd -y zn-gate init`', 'win32'), '`zn.cmd hooks install x` `npx.cmd -y zn-gate init`');
});

test('manual command lines are rewritten on win32 and left alone elsewhere', () => {
  assert.equal(winManualText('zn hooks install codex', 'win32'), 'zn.cmd hooks install codex');
  assert.equal(winManualText('zn-gate check (go on only if it says the hooks work)', 'win32'), 'zn-gate.cmd check (go on only if it says the hooks work)');
  assert.equal(winManualText('zn hooks install codex', 'linux'), 'zn hooks install codex');
});

test('POSIX output is unchanged', () => {
  const t = 'Run `npx -y zn-gate init` then `zn hooks install codex`; no zn check runs. zn hooks install';
  assert.equal(winCommandText(t, 'linux'), t);
  assert.equal(winCommandText(t, 'darwin'), t);
});

async function runGuide(t, platform) {
  const home = tempDir(t, 'zn-wincmd-home-');
  fs.mkdirSync(home + '/.codex', { recursive: true });
  let s = '';
  await asPlatformAsync(platform, () => guide({ nodeVersion: '22.0.0', home, env: { HOME: home, PATH: '' }, cwd: tempDir(t, 'zn-wincmd-cwd-'), claude: null, ancestry: () => null,
    temporary: false, stdin: { isTTY: false }, write: (x) => { s += x; }, run: () => true, confirm: async () => true }));
  return s;
}

test('init on win32: manual steps use zn.cmd, the sentences around them do not change', async (t) => {
  const win = await runGuide(t, 'win32');
  assert.match(win, /^ {2}zn\.cmd hooks install codex$/m);
  assert.match(win, /Then check that it works: `npx\.cmd -y zn-gate check`/);
  assert.match(win, /zn-gate init: set up zn for the coding agents on this machine/);
  assert.match(win, /This is not an interactive terminal, so zn only prints the steps\. Nothing was changed\./);
  assert.doesNotMatch(win, /zn-gate\.cmd init: set up/);
  const posix = await runGuide(t, 'linux');
  assert.match(posix, /^ {2}zn hooks install codex$/m);
  assert.doesNotMatch(posix, /\.cmd/);
});
