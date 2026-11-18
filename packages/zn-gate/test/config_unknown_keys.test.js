'use strict';

process.env.ZN_STATS = 'off';

// Keys zn does not read and text values outside a setting's set are reported with the closest valid name or the valid
// values. The value a setting had before is unchanged (an invalid value keeps the default, never a weaker level), and a
// valid file reports nothing. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const znConfig = require('../lib/zn-config');
const { tempDir } = require('./helpers/tmp');

function homeWith(t, obj) {
  const home = tempDir(t, 'zn-cfgkeys-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(obj));
  return home;
}

test('a valid file with every known key reports nothing', (t) => {
  const home = homeWith(t, {
    hooks: {
      blockDestructiveCommands: true, strict: true, replaceToolOutputOnSecret: true, checkToolOutputInstructions: true,
      cloudCheckToolOutput: false, stopReview: 'Block', whenUnavailable: 'deny', failMode: 'closed',
      agentInstructionWrites: 'ask', egressCheck: false, egressAllowHosts: ['example.com'],
      packageInstallCheck: 'offline', packageInstallAllow: ['left-pad'], packageInstallNewDays: 14, packageInstallNotices: true,
    },
    mcpPinning: 'warn', stats: { share: false }, cloud: { store: 'x' },
  });
  assert.deepEqual(runner.configProblems({ home }), []);
});

test('a misspelt key under hooks is reported with the closest valid key', (t) => {
  const home = homeWith(t, { hooks: { blockDestructiveCommand: true, stirct: true, egresCheck: 'deny' } });
  const p = runner.configProblems({ home });
  assert.equal(p.length, 3);
  assert.match(p[0], /"blockDestructiveCommand".*Did you mean "blockDestructiveCommands"\?/);
  assert.match(p[1], /"stirct".*Did you mean "strict"\?/);
  assert.match(p[2], /"egresCheck".*Did you mean "egressCheck"\?/);
});

test('a key with no close match lists the keys zn reads', (t) => {
  const home = homeWith(t, { hooks: { somethingElseEntirely: 1 } });
  const p = runner.configProblems({ home });
  assert.equal(p.length, 1);
  assert.match(p[0], /does not read/);
  assert.match(p[0], /blockDestructiveCommands/);
  assert.doesNotMatch(p[0], /Did you mean/);
});

test('an unknown top-level key is reported with a suggestion, also a different letter case', (t) => {
  const home = homeWith(t, { Hooks: {}, mcpPining: 'block', extra: true });
  const p = runner.configProblems({ home });
  assert.equal(p.length, 3);
  assert.match(p[0], /top level.*"Hooks".*Did you mean "hooks"\?/);
  assert.match(p[1], /"mcpPining".*Did you mean "mcpPinning"\?/);
  assert.match(p[2], /"extra"/);
});

test('an enum value outside its set is reported with the valid values and the level stays at the default', (t) => {
  const home = homeWith(t, { hooks: { agentInstructionWrites: 'block', egressCheck: 'strict', stopReview: 'deny', packageInstallCheck: 'on', failMode: 'close', whenUnavailable: 'ask' } });
  const p = runner.configProblems({ home });
  assert.equal(p.length, 6);
  assert.match(p[0], /"agentInstructionWrites" is "block".*"ask", "deny", "off", "allow".*default/);
  assert.match(p[2], /"stopReview" is "deny".*"warn", "block"/);
  assert.match(p[3], /"packageInstallCheck" is "on".*"off", "offline", "online"/);
  assert.match(p[4], /"failMode" is "close".*"open", "closed"/);
  // Never fail open: the typos read as the defaults.
  const hooks = runner.readConfig(home).hooks;
  assert.equal(hooks.agentInstructionWrites, 'block');
});

test('an invalid mcpPinning is reported', (t) => {
  for (const [v, re] of [['blok', /"mcpPinning" is "blok".*"off", "warn", "block"/], [3, /"mcpPinning" is a number/]]) {
    const home = homeWith(t, { mcpPinning: v });
    const p = runner.configProblems({ home });
    assert.equal(p.length, 1);
    assert.match(p[0], re);
  }
});

test('the hook message carries the unknown-key problem once per session', (t) => {
  const home = homeWith(t, { hooks: { blockDestructiveCommand: true } });
  const text = znConfig.notice(runner.configProblems({ home }));
  assert.match(text, /Did you mean "blockDestructiveCommands"\?/);
  assert.match(text, /zn-gate status/);
});

test('zn-gate check reports the unknown key as a warning', async (t) => {
  const home = homeWith(t, { hooks: { stirct: true } });
  const { check } = require('../lib/check');
  const r = await check({ home, live: false, env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home });
  assert.ok(r.warnings.some((w) => /"stirct".*Did you mean "strict"\?/.test(w)), JSON.stringify(r.warnings));
});
