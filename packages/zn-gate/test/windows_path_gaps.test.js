'use strict';

process.env.ZN_STATS = 'off';

// Windows spellings of protected paths and destructive targets. Strings only: nothing is read from disk or run.
//   - path:sensitive_file and the destructive-command policy, on the table in fixtures/windows_path_gap_cases.json
//     (tests/test_windows_path_gaps.py checks the same table in the Python package);
//   - the hook policy (classifyPath), with the platform flag and the path module switched to their Windows form.
// A case with a gap id names a spelling Windows resolves to a protected target that is not caught yet. Those tests are
// skipped; set ZN_RUN_GAP_TESTS=1 to run them and see which still fail. Remove the skip for a gap when it is fixed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkToolCall } = require('../lib/guard');
const { checkCommand } = require('../lib/destructive');
const policy = require('../lib/hooks/policy');

const { text, text_allowed: textAllowed, destructive, destructive_allowed: destructiveAllowed } =
  require(path.join(__dirname, 'fixtures', 'windows_path_gap_cases.json'));

const RUN_GAPS = process.env.ZN_RUN_GAP_TESTS === '1';
const gapOpt = (id) => (RUN_GAPS ? {} : { skip: 'open gap ' + id });

function group(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.id)) by.set(r.id, []);
    by.get(r.id).push(r);
  }
  return by;
}

function pathBlocked(p) {
  const out = [];
  for (const [tool, args] of [['read_file', { path: p }], ['shell', { command: 'cat "' + p + '"' }], ['shell', { command: 'type ' + p }]]) {
    const res = checkToolCall(tool, args);
    if (res.rule !== 'path:sensitive_file') out.push(tool + ' ' + JSON.stringify(args) + ' -> ' + res.verdict + ' (' + res.rule + ')');
  }
  return out;
}

for (const [id, rows] of group(text)) {
  const name = id === 'ok' ? 'path:sensitive_file blocks these Windows spellings' : id + ': path:sensitive_file blocks the Windows spelling';
  test(name, id === 'ok' ? {} : gapOpt(id), () => {
    const missed = [];
    for (const r of rows) missed.push(...pathBlocked(r.path));
    assert.deepEqual(missed, []);
  });
}

test('path:sensitive_file leaves device names and templates alone', () => {
  for (const p of textAllowed) {
    for (const [tool, args] of [['read_file', { path: p }], ['shell', { command: 'cat "' + p + '"' }]]) {
      assert.notEqual(checkToolCall(tool, args).rule, 'path:sensitive_file', tool + ' ' + p);
    }
  }
});

for (const [id, rows] of group(destructive)) {
  const name = id === 'ok' ? 'destructive policy blocks these Windows spellings of a system or home folder' : id + ': destructive policy blocks the Windows spelling';
  test(name, id === 'ok' ? {} : gapOpt(id), () => {
    const missed = rows.filter((r) => checkCommand(r.command).verdict !== 'block').map((r) => r.command);
    assert.deepEqual(missed, []);
  });
}

test('destructive policy leaves a build folder and the null device alone', () => {
  for (const c of destructiveAllowed) assert.equal(checkCommand(c).verdict, 'allow', c);
});

// --- hook policy: classifyPath with Windows platform and path semantics ---

const PATH_KEYS = ['resolve', 'join', 'isAbsolute', 'basename', 'dirname', 'parse', 'normalize', 'relative', 'sep', 'delimiter', 'extname'];
function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {};
  for (const k of PATH_KEYS) saved[k] = path[k];
  Object.defineProperty(process, 'platform', { value: 'win32' });
  for (const k of PATH_KEYS) path[k] = path.win32[k];
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', real);
    for (const k of PATH_KEYS) path[k] = saved[k];
  }
}
const HOME = 'C:\\Users\\alice';
const O = { cwd: HOME + '\\proj', home: HOME, env: {} };
function misclassified(cases) {
  return asWindows(() => {
    const bad = [];
    for (const [p, kind] of cases) {
      const c = policy.classifyPath(p, O);
      const got = c ? c.kind : null;
      if (got !== kind) bad.push(p + ' -> ' + got + ' (want ' + kind + ')');
    }
    return bad;
  });
}

test('classifyPath names the protected target behind these Windows spellings', () => {
  assert.deepEqual(misclassified([
    ['.env.', 'dotenv'], ['.env ', 'dotenv'], ['.ENV', 'dotenv'], ['.env::$DATA', 'dotenv'], ['.env:x', 'dotenv'], ['.env.::$DATA', 'dotenv'],
    ['c:/users/alice/proj/.env', 'dotenv'], ['C:.env', 'dotenv'], ['\\Users\\alice\\proj\\.env', 'dotenv'],
    ['\\\\?\\C:\\Users\\alice\\proj\\.env', 'dotenv'], ['\\\\.\\C:\\Users\\alice\\proj\\.env', 'dotenv'],
    ['C:/Users\\alice/proj\\.env', 'dotenv'], ['C:\\\\Users\\\\alice\\\\proj\\\\.env', 'dotenv'], ['sub\\..\\.env', 'dotenv'],
    ['.ssh.\\id_rsa', 'credential'], ['.\\.ssh \\id_rsa', 'credential'], ['\\\\?\\C:\\Users\\alice\\.ssh\\id_rsa', 'credential'],
    ['\\\\localhost\\C$\\Users\\alice\\.ssh\\id_rsa', 'credential'], ['C:\\Users\\alice\\.ssh::$INDEX_ALLOCATION\\id_rsa', 'credential'],
    ['C:\\Users\\alice\\.aws\\credentials::$DATA', 'credential'], ['C:\\Users\\alice\\.npmrc.', 'credential'],
    ['C:\\Users\\alice\\.zn\\vault', 'zn_state'], ['c:/users/alice/.zn/vault', 'zn_state'], ['C:\\Users\\alice\\.zn.\\vault', 'zn_state'],
    ['C:\\Users\\alice\\.zn::$INDEX_ALLOCATION\\vault', 'zn_state'], ['C:\\Users\\alice\\proj\\..\\.zn\\vault', 'zn_state'],
    ['C:\\Users\\alice\\.claude\\settings.json:Zone.Identifier', 'agent_config'], ['\\\\?\\C:\\Users\\alice\\.claude\\settings.json', 'agent_config'],
    ['\\\\localhost\\C$\\Users\\alice\\.claude\\settings.json', 'agent_config'],
  ]), []);
});

test('classifyPath leaves device names and templates alone on Windows', () => {
  assert.deepEqual(misclassified([
    ['NUL', null], ['CON', null], ['COM1', null], ['NUL.txt', null], ['\\\\.\\NUL', null], ['\\\\.\\COM1', null],
    ['.env.example', null], ['.env.example.', null], ['.env.example::$DATA', null], ['C:\\Users\\alice\\.ssh\\id_rsa.pub', null],
  ]), []);
});

test('WN1-extended-prefix: classifyPath sees through \\\\?\\, \\\\.\\ and a local admin share for folders anchored at the home folder', gapOpt('WN1-extended-prefix'), () => {
  assert.deepEqual(misclassified([
    ['\\\\?\\C:\\Users\\alice\\.zn\\vault', 'zn_state'], ['\\\\.\\C:\\Users\\alice\\.zn\\vault', 'zn_state'], ['\\\\?\\c:\\users\\alice\\.zn\\vault', 'zn_state'],
    ['\\\\localhost\\C$\\Users\\alice\\.zn\\vault', 'zn_state'], ['\\\\127.0.0.1\\c$\\Users\\alice\\.zn\\vault', 'zn_state'],
    ['\\\\?\\UNC\\localhost\\C$\\Users\\alice\\.zn\\vault', 'zn_state'],
    ['\\\\?\\C:\\Users\\alice\\.npmrc', 'credential'], ['\\\\localhost\\C$\\Users\\alice\\.pypirc', 'credential'],
    ['\\\\localhost\\C$\\Users\\alice\\.codex', 'agent_config'],
  ]), []);
});
