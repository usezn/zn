'use strict';
/* Next-step commands on Windows use the .cmd shims: PowerShell with the default
 * Restricted policy refuses to run zn.ps1 and npx.ps1. Other systems are unchanged. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { znCommand, cliName, winCommandText, PACKAGE_VERSION } = require('../lib/zn-command');

const NPX = 'npx -y zn-gate@' + PACKAGE_VERSION;

function asPlatform(value, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

const noPath = { PATH: '' };

test('cliName: .cmd shims on win32, plain names elsewhere', () => {
  asPlatform('win32', () => {
    assert.equal(cliName('zn'), 'zn.cmd');
    assert.equal(cliName('npx'), 'npx.cmd');
    assert.equal(cliName('zn-gate'), 'zn-gate.cmd');
  });
  asPlatform('linux', () => {
    assert.equal(cliName('zn'), 'zn');
    assert.equal(cliName('npx'), 'npx');
  });
});

test('znCommand on win32: the npx form uses npx.cmd', () => {
  asPlatform('win32', () => {
    assert.equal(znCommand('env shadow .env', { env: noPath }), 'npx.cmd -y zn-gate@' + PACKAGE_VERSION + ' env shadow .env');
    assert.equal(znCommand('', { env: noPath }), 'npx.cmd -y zn-gate@' + PACKAGE_VERSION);
  });
});

test('znCommand on POSIX is unchanged', () => {
  asPlatform('linux', () => {
    assert.equal(znCommand('env shadow .env', { env: noPath }), NPX + ' env shadow .env');
    assert.equal(znCommand('unlock', { env: noPath }), NPX + ' unlock');
  });
});

test('winCommandText on win32 rewrites zn and npx commands to the .cmd forms', () => {
  asPlatform('win32', () => {
    assert.equal(
      winCommandText('Run `npx -y zn-gate init` in your own terminal, then `zn hooks install codex`.'),
      'Run `npx.cmd -y zn-gate init` in your own terminal, then `zn.cmd hooks install codex`.'
    );
    assert.equal(
      winCommandText('then run `zn-gate check` again; or zn env shadow .env'),
      'then run `zn-gate.cmd check` again; or zn.cmd env shadow .env'
    );
    assert.equal(
      winCommandText('Ask the user to run npx -y zn-gate@1.14.1 env shadow .env'),
      'Ask the user to run npx.cmd -y zn-gate@1.14.1 env shadow .env'
    );
  });
});

test('winCommandText on win32 leaves prose and already-.cmd text alone', () => {
  asPlatform('win32', () => {
    const prose = 'zn checks tool calls before they run; the zn-gate plugin and zn.cmd hooks install are kept';
    assert.equal(winCommandText(prose), 'zn checks tool calls before they run; the zn-gate plugin and zn.cmd hooks install are kept');
    assert.equal(winCommandText('zn.cmd hooks install codex'), 'zn.cmd hooks install codex');
    assert.equal(winCommandText('npx.cmd -y zn-gate init'), 'npx.cmd -y zn-gate init');
  });
});

test('winCommandText on POSIX returns the text unchanged', () => {
  const text = 'Run `npx -y zn-gate init` then `zn hooks install codex` and `zn-gate check`';
  asPlatform('linux', () => {
    assert.equal(winCommandText(text), text);
  });
  assert.equal(winCommandText(text, 'darwin'), text);
});
