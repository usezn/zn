'use strict';
// How `scan` counts lines (a line ends at CRLF, CR or LF only, as in the Python package, editors and GitHub),
// and what `audit --format sarif` says about folders it did not read and about files in the home folder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { toSarif } = require('../lib/audit/report');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ENV = { ...process.env, ZN_LOCAL_ONLY: 'true' };
// A fake key from the AWS documentation.
const KEY = 'AKIAIOSFODNN7EXAMPLE';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scanLines(t, text) {
  const dir = tempDir(t, 'zn-scan-lines-');
  fs.writeFileSync(path.join(dir, 'notes.md'), text);
  const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'json'], { encoding: 'utf8', env: ENV });
  return JSON.parse(r.stdout).threats.filter((x) => x.type === 'secret_leak').map((x) => x.line);
}

// These end a line.
for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['lone CR', '\r']]) {
  test('scan: ' + name + ' ends a line', (t) => {
    const text = ['a line of prose here', 'another line of prose', 'key = ' + KEY, 'the last line'].join(eol) + eol;
    assert.deepStrictEqual(scanLines(t, text), [3]);
  });
}

test('scan: lines mixed with every terminator are counted one by one', (t) => {
  assert.deepStrictEqual(scanLines(t, 'one one one\r\ntwo two two\rthree three\nkey = ' + KEY + '\r\n'), [4]);
});

// These do not: editors and GitHub keep them inside the line.
for (const [name, sep] of [['U+2028', ' '], ['U+2029', ' '], ['vertical tab', '\x0b'], ['form feed', '\x0c'], ['U+0085', '\u0085'], ['file separator', '\x1c']]) {
  test('scan: ' + name + ' does not end a line', (t) => {
    const text = 'first part of line one' + sep + 'second part of line one\nkey = ' + KEY + '\n';
    assert.deepStrictEqual(scanLines(t, text), [2]);
  });
}

test('scan: a multi-line private key is found at its first line with CR line ends', (t) => {
  const pem = ['intro line here', '-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu', 'KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm', '-----END RSA PRIVATE KEY-----', 'after'].join('\r') + '\r';
  const dir = tempDir(t, 'zn-scan-pem-');
  fs.writeFileSync(path.join(dir, 'k.md'), pem);
  const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'json'], { encoding: 'utf8', env: ENV });
  const lines = JSON.parse(r.stdout).threats.map((x) => x.line);
  assert.deepStrictEqual(lines, [2]);
});

/* -------------------------- audit SARIF --------------------------- */

const finding = (over) => Object.assign({ id: 'ZNA001', severity: 'high', agent: 'claude', file: '.claude/settings.json', line: 2, title: 'A hook', detail: 'runs a command', evidence: 'e', fix: 'remove it', references: [] }, over);
const sarifOf = (result) => JSON.parse(toSarif(Object.assign({ findings: [], skippedDirs: [], truncated: false }, result), { toolVersion: '0.0.0' })).runs[0];

test('audit SARIF: a complete audit says so in its invocation', () => {
  const run = sarifOf({ findings: [finding()] });
  assert.deepStrictEqual(run.invocations, [{ executionSuccessful: true, toolExecutionNotifications: [] }]);
  assert.strictEqual(run.results.length, 1);
});

test('audit SARIF: folders that were not read and an early stop make it incomplete', () => {
  const run = sarifOf({ skippedDirs: [{ dir: 'locked', reason: 'cannot be read' }, { dir: '/abs/elsewhere', reason: 'cannot be read' }], truncated: true });
  const inv = run.invocations[0];
  assert.strictEqual(inv.executionSuccessful, false);
  const texts = inv.toolExecutionNotifications.map((n) => n.message.text);
  assert.strictEqual(texts.length, 3);
  assert.ok(texts[0].includes('Folder locked'), texts[0]);
  assert.ok(!texts[1].includes('/abs/elsewhere'), 'a path outside the repository is not named');
  assert.ok(texts[2].includes('stopped early'));
  for (const n of inv.toolExecutionNotifications) assert.strictEqual(n.level, 'warning');
});

test('audit SARIF: a truncated scan alone is incomplete', () => {
  assert.strictEqual(sarifOf({ truncated: true }).invocations[0].executionSuccessful, false);
});

test('audit SARIF: findings in the home folder become one notification without file names', () => {
  const run = sarifOf({ findings: [finding(), finding({ file: '~/.cursor/mcp.json', id: 'ZNA011' }), finding({ file: '~/.claude.json', id: 'ZNA003', severity: 'medium' })] });
  assert.strictEqual(run.results.length, 1);
  const text = JSON.stringify(run);
  assert.ok(!text.includes('"HOME"'), 'no result or base id for the home folder');
  assert.ok(!text.includes('.cursor') && !text.includes('.claude.json'), 'no home file name');
  const notes = run.invocations[0].toolExecutionNotifications;
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].level, 'error');
  assert.ok(notes[0].message.text.startsWith('2 findings in files in the home folder'));
  assert.deepStrictEqual(notes[0].properties, { count: 2, rules: ['ZNA003', 'ZNA011'] });
  // Only the audited folder is a base: every result resolves against it.
  assert.deepStrictEqual(Object.keys(run.originalUriBaseIds), ['%SRCROOT%']);
});
