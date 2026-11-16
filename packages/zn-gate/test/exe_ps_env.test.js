'use strict';
process.env.ZN_STATS = 'off';
// psEnv and systemPsModulePath with fake inputs: case-insensitive removal, other variables kept, extra wins over base.
const test = require('node:test');
const assert = require('node:assert/strict');
const exe = require('../lib/exe');

const PS = 'D:\\Tools\\PS\\powershell.exe';
const MODULES = 'D:\\Tools\\PS\\Modules';
const psKeys = (env) => Object.keys(env).filter((k) => /^psmodulepath$/i.test(k));

test('systemPsModulePath: Modules sits next to the given powershell.exe', () => {
  assert.equal(exe.systemPsModulePath(PS), MODULES);
  assert.equal(exe.systemPsModulePath('E:\\x\\y\\powershell.exe'), 'E:\\x\\y\\Modules');
});

test('psEnv: PSModulePath in any case is replaced in the base environment', () => {
  for (const key of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath', 'pSmOdUlEpAtH']) {
    const env = exe.psEnv(PS, { [key]: 'C:\\fake', KEEP: '1' }, {});
    assert.deepEqual(psKeys(env), ['PSModulePath'], key);
    assert.equal(env.PSModulePath, MODULES, key);
    assert.equal(env.KEEP, '1');
  }
});

test('psEnv: PSModulePath in any case is replaced in the extra environment', () => {
  for (const key of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath']) {
    const env = exe.psEnv(PS, { A: 'a' }, { [key]: 'C:\\fake', B: 'b' });
    assert.deepEqual(psKeys(env), ['PSModulePath'], key);
    assert.equal(env.PSModulePath, MODULES, key);
    assert.equal(env.A, 'a');
    assert.equal(env.B, 'b');
  }
});

test('psEnv: other variables are kept and extra wins over base', () => {
  const env = exe.psEnv(PS, { A: 'base', B: 'base', Path: 'p' }, { B: 'extra', C: 'extra' });
  assert.deepEqual(env, { A: 'base', B: 'extra', Path: 'p', C: 'extra', PSModulePath: MODULES });
});

test('psEnv: the inputs are not modified', () => {
  const base = { A: '1', PSMODULEPATH: 'C:\\fake' };
  const extra = { B: '2', psmodulepath: 'C:\\fake2' };
  exe.psEnv(PS, base, extra);
  assert.deepEqual(base, { A: '1', PSMODULEPATH: 'C:\\fake' });
  assert.deepEqual(extra, { B: '2', psmodulepath: 'C:\\fake2' });
});

test('psEnv: without a base it starts from the process environment', () => {
  const prev = process.env.ZN_TEST_PS_ENV;
  process.env.ZN_TEST_PS_ENV = 'yes';
  try {
    const env = exe.psEnv(PS);
    assert.equal(env.ZN_TEST_PS_ENV, 'yes');
    assert.deepEqual(psKeys(env), ['PSModulePath']);
    assert.equal(env.PSModulePath, MODULES);
  } finally {
    if (prev === undefined) delete process.env.ZN_TEST_PS_ENV; else process.env.ZN_TEST_PS_ENV = prev;
  }
});
