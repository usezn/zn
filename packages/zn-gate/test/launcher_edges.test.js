'use strict';

// Edge cases of two launcher helpers: windowsScriptCommand (the -EncodedCommand call of a PowerShell script) and
// unixScript (the text of the sh launcher). Only the returned text is checked; paths and digests are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const { shQuote, powershellExe, CMD_POWERSHELL } = require('../lib/shell-quote');
const { tempDir } = require('./helpers/tmp');

const NODE = '/opt/example/bin/node';
const RUNNER = '/opt/example/zn-gate/lib/hooks/runner.js';
const DIGEST = 'ab'.repeat(32);
const BASE = { runnerDigest: DIGEST, manifest: '', platform: 'linux' };

const SUFFIX = ' -NoProfile -NonInteractive -EncodedCommand ';

function decode(command) {
  const i = command.indexOf(SUFFIX);
  assert.ok(i > 0, command);
  return { exe: command.slice(0, i), script: Buffer.from(command.slice(i + SUFFIX.length), 'base64').toString('utf16le') };
}

function line(text, prefix) {
  return text.split('\n').find((l) => l.startsWith(prefix));
}

// windowsScriptCommand

test('windowsScriptCommand: an empty script gives the call with an empty payload', () => {
  const cmd = launcher.windowsScriptCommand('', { cmd: true });
  assert.equal(cmd, CMD_POWERSHELL + SUFFIX);
});

test('windowsScriptCommand: cmd: true starts with the %SystemRoot% form of powershell.exe', () => {
  const { exe, script } = decode(launcher.windowsScriptCommand('exit 0', { cmd: true }));
  assert.equal(exe, CMD_POWERSHELL);
  assert.equal(script, 'exit 0');
});

test('windowsScriptCommand: without opts, or with a falsy cmd, the system powershell.exe is used', () => {
  if (process.platform === 'win32') return; // the Windows path depends on the machine
  const exe = powershellExe();
  for (const opts of [undefined, {}, { cmd: false }, { cmd: 0 }, { cmd: '' }]) {
    const cmd = launcher.windowsScriptCommand('exit 0', opts);
    assert.equal(decode(cmd).exe, exe, JSON.stringify(opts));
  }
});

test('windowsScriptCommand: quotes, $, backticks, newlines and non-ASCII text round-trip and never appear in the command', () => {
  const text = "$a = 'x'; \"b\" `n %PATH% & | > < ^ !\r\n\u00e9\u4e2d\ud83d\ude00 C:\\example\\dir";
  const cmd = launcher.windowsScriptCommand(text, { cmd: true });
  assert.equal(decode(cmd).script, text);
  const payload = cmd.slice(cmd.indexOf(SUFFIX) + SUFFIX.length);
  assert.match(payload, /^[A-Za-z0-9+/]*={0,2}$/);
  assert.equal(payload, Buffer.from(text, 'utf16le').toString('base64'));
});

test('windowsScriptCommand: a long script is encoded in full', () => {
  const text = 'Write-Output 1; '.repeat(2000);
  assert.equal(decode(launcher.windowsScriptCommand(text, { cmd: true })).script, text);
});

test('windowsScriptCommand: a script that is not a string throws', () => {
  for (const bad of [undefined, null, 42]) {
    assert.throws(() => launcher.windowsScriptCommand(bad, { cmd: true }), TypeError, String(bad));
  }
});

// unixScript: agent id

test('unixScript: agent ids outside lower-case letters and dashes are refused', () => {
  for (const bad of ['', 'Codex', 'codex2', 'co dex', 'co_dex', '../codex', 'codex\n', 'codex;']) {
    assert.throws(() => launcher.unixScript(bad, NODE, RUNNER, BASE), /bad agent id/, JSON.stringify(bad));
  }
});

test('unixScript: an agent id with no table entry gets the default blocking events', () => {
  const text = launcher.unixScript('example-agent', NODE, RUNNER, BASE);
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.ok(text.includes('zn hooks install example-agent'));
  assert.ok(text.includes('\n  ' + [...launcher.BLOCK_EXIT].join('|') + ')\n'));
  assert.ok(text.includes('\n  ' + [...launcher.BLOCK_JSON].join('|') + ')\n'));
  assert.ok(text.endsWith('zn_block\n'));
});

// unixScript: runner digest

test('unixScript: an empty runner digest is kept and the file list becomes "-"', () => {
  const text = launcher.unixScript('codex', NODE, RUNNER, { runnerDigest: '', platform: 'linux' });
  assert.equal(line(text, 'ZN_SHA='), "ZN_SHA=''");
  assert.equal(line(text, 'ZN_FILES='), "ZN_FILES='-'");
});

test('unixScript: a digest that is not lower-case hex is refused', () => {
  for (const bad of ['AB'.repeat(32), 'xyz', 'ab cd', 'ab\n', null, 42, {}]) {
    assert.throws(() => launcher.unixScript('codex', NODE, RUNNER, { runnerDigest: bad, manifest: '' }), /bad runner digest/, String(bad));
  }
});

test('unixScript: without a digest, a missing runner gives an empty digest', (t) => {
  const dir = tempDir(t, 'zn-launcher-edges-');
  const text = launcher.unixScript('codex', NODE, path.join(dir, 'missing.js'), { platform: 'linux' });
  assert.equal(line(text, 'ZN_SHA='), "ZN_SHA=''");
  assert.equal(line(text, 'ZN_FILES='), "ZN_FILES='-'");
});

test('unixScript: without a digest, the SHA-256 of the runner file is recorded; outside a package there is no file list', (t) => {
  const dir = tempDir(t, 'zn-launcher-edges-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, '// example runner\n');
  const sha = crypto.createHash('sha256').update('// example runner\n').digest('hex');
  const text = launcher.unixScript('codex', NODE, runner, { platform: 'linux' });
  assert.equal(line(text, 'ZN_SHA='), 'ZN_SHA=' + shQuote(sha));
  assert.equal(line(text, 'ZN_FILES='), "ZN_FILES='-'");
});

// unixScript: manifest

test('unixScript: a manifest that cannot be parsed is refused', () => {
  for (const bad of ['x', 'lib/a.js=abc', '=' + DIGEST, 'lib/a b.js=' + DIGEST, 'lib/a.js=' + DIGEST + ';', 'lib/a.js=' + 'AB'.repeat(32)]) {
    assert.throws(() => launcher.unixScript('codex', NODE, RUNNER, { runnerDigest: DIGEST, manifest: bad }), /bad manifest/, bad);
  }
});

test('unixScript: a valid manifest is written as is; an empty one becomes "-"', () => {
  const manifest = 'lib/a.js=' + DIGEST + ';lib/hooks/runner.js=' + 'cd'.repeat(32);
  const text = launcher.unixScript('codex', NODE, RUNNER, { ...BASE, manifest });
  assert.equal(line(text, 'ZN_FILES='), 'ZN_FILES=' + shQuote(manifest));
  assert.equal(line(launcher.unixScript('codex', NODE, RUNNER, BASE), 'ZN_FILES='), "ZN_FILES='-'");
});

// unixScript: deadline

test('unixScript: deadlineS that is not a positive whole number means no deadline', () => {
  for (const deadlineS of [0, -1, 1.5, '5', NaN, Infinity, null]) {
    const text = launcher.unixScript('codex', NODE, RUNNER, { ...BASE, deadlineS });
    assert.doesNotMatch(text, /zn_run|zn_term/, String(deadlineS));
    assert.match(text, /ZN_RAN=1; zn_cap "\$ZN_NODE"/);
  }
});

test('unixScript: deadlineS 1 is the smallest deadline that is written', () => {
  const text = launcher.unixScript('codex', NODE, RUNNER, { ...BASE, deadlineS: 1 });
  assert.match(text, /\nzn_term\(\) \{\n/);
  assert.match(text, /\/bin\/sleep 1 & ZN_SP=\$!/);
  assert.match(text, /ZN_RAN=1; zn_run "\$ZN_NODE"/);
});

test('unixScript: deadlineSoft decides what happens when no timer can run', () => {
  const strict = launcher.unixScript('zcode', NODE, RUNNER, { ...BASE, deadlineS: 5 });
  const soft = launcher.unixScript('zcode', NODE, RUNNER, { ...BASE, deadlineS: 5, deadlineSoft: true });
  assert.ok(strict.includes('[ -x /bin/sleep ] || { ZN_RC=127; return 0; }'));
  assert.ok(soft.includes('[ -x /bin/sleep ] || { zn_cap "$@"; return 0; }'));
  // Without a deadline the flag changes nothing.
  assert.equal(launcher.unixScript('zcode', NODE, RUNNER, { ...BASE, deadlineSoft: true }), launcher.unixScript('zcode', NODE, RUNNER, BASE));
});

// unixScript: paths

test('unixScript: paths with spaces, quotes and $ are single-quoted', () => {
  const node = "/opt/it's here/$HOME/node";
  const runner = '/opt/a "b"/`x`/runner.js';
  const text = launcher.unixScript('codex', node, runner, BASE);
  assert.equal(line(text, 'ZN_NODE='), 'ZN_NODE=' + shQuote(node));
  assert.equal(line(text, 'ZN_RUNNER='), 'ZN_RUNNER=' + shQuote(runner));
});

test('unixScript: a path with a NUL character is refused', () => {
  assert.throws(() => launcher.unixScript('codex', '/opt/example/no\0de', RUNNER, BASE), /NUL/);
  assert.throws(() => launcher.unixScript('codex', NODE, '/opt/example/run\0ner.js', BASE), /NUL/);
});

test('unixScript: the script text is valid sh for odd paths and every option', (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/bin/sh')) return t.skip('no /bin/sh');
  const node = "/opt/it's here/$HOME/node";
  const runner = '/opt/a "b"/`x`/runner.js';
  for (const agent of ['codex', 'claude-code', 'cursor', 'antigravity', 'zcode', 'example-agent']) {
    for (const opts of [{}, { deadlineS: 3 }, { deadlineS: 3, deadlineSoft: true }]) {
      const text = launcher.unixScript(agent, node, runner, { ...BASE, ...opts });
      const r = spawnSync('/bin/sh', ['-n'], { input: text, encoding: 'utf8' });
      assert.equal(r.status, 0, agent + ' ' + JSON.stringify(opts) + ': ' + r.stderr);
    }
  }
});
