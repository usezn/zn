'use strict';
// `zn audit --agents <name>` says so when that agent had nothing to read,
// instead of "No findings in 0 agent files".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function repo(t, files) {
  const dir = tempDir(t, 'zn-audit-nc-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
function cli(args) {
  return spawnSync(process.execPath, [CLI, 'audit', ...args], { encoding: 'utf8' });
}

test('audit: an agent with no files is reported as not checked', (t) => {
  const dir = repo(t, { 'README.md': '# hi\n' });
  const r = cli([dir, '--agents', 'cursor']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /No findings in 0/);
  assert.match(r.stdout, /Nothing was checked/);
  assert.match(r.stdout, /cursor: not checked \(no instruction or config files found where zn looks: .*\.cursor/);
});

test('audit: files for one agent do not hide another that was not checked', (t) => {
  const dir = repo(t, { 'CLAUDE.md': 'Run the tests before you commit.\n' });
  const r = cli([dir, '--agents', 'claude,codex']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No findings in the 1 file that was read\./);
  assert.match(r.stdout, /codex: not checked/);
  assert.doesNotMatch(r.stdout, /claude: not checked/);
});

test('audit: an agent with files keeps the usual message', (t) => {
  const dir = repo(t, { 'CLAUDE.md': 'Run the tests before you commit.\n' });
  const r = cli([dir, '--agents', 'claude']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No findings in 1 agent file\./);
  assert.doesNotMatch(r.stdout, /not checked/);
});

test('audit: without --agents no per-agent lines are printed', (t) => {
  const dir = repo(t, { 'CLAUDE.md': 'Run the tests before you commit.\n' });
  const r = cli([dir]);
  assert.match(r.stdout, /No findings in 1 agent file\./);
  assert.doesNotMatch(r.stdout, /not checked/);
  const empty = cli([repo(t, { 'README.md': 'x\n' })]);
  assert.match(empty.stdout, /Nothing was checked/);
});

test('audit: JSON says per agent whether anything was checked', (t) => {
  const dir = repo(t, { 'CLAUDE.md': 'Run the tests before you commit.\n' });
  const j = JSON.parse(cli([dir, '--agents', 'claude,codex', '--format', 'json']).stdout);
  assert.deepEqual(j.summary.agentStatus, [
    { agent: 'claude', files: 1, checked: true },
    { agent: 'codex', files: 0, checked: false },
  ]);
  assert.deepEqual(j.summary.agents, ['claude', 'codex']);
  assert.equal(j.summary.files, 1);
});

test('audit: an agent not checked does not change the exit code', (t) => {
  const dir = repo(t, { 'README.md': 'x\n' });
  assert.equal(cli([dir, '--agents', 'gemini']).status, 0);
});

// A file that exists but cannot be opened is a finding, not a clean run.
// openSync is stubbed in a preloaded module (chmod does nothing when CI runs as root).
const STUB = path.join(__dirname, 'helpers', 'deny_open.js');
function cliDenied(args, file) {
  return spawnSync(process.execPath, ['-r', STUB, CLI, 'audit', ...args], { encoding: 'utf8', env: { ...process.env, ZN_TEST_DENY: file } });
}

test('audit: an unreadable agent file is a high finding, not "No findings"', (t) => {
  const dir = repo(t, { 'AGENTS.md': 'Run the tests.\n', 'CLAUDE.md': 'Run the tests before you commit.\n' });
  const r = cliDenied([dir, '--format', 'json'], path.join(dir, 'CLAUDE.md'));
  const j = JSON.parse(r.stdout);
  const f = j.findings.filter((x) => x.id === 'ZNA020');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'high');
  assert.equal(f[0].file, 'CLAUDE.md');
  assert.match(f[0].detail, /exists but could not be read \(EACCES\), so it was not checked/);
  assert.equal(r.status, 1);
  const text = cliDenied([dir], path.join(dir, 'CLAUDE.md'));
  assert.doesNotMatch(text.stdout, /No findings/);
  assert.match(text.stdout, /ZNA020/);
});

test('audit: --agents claude with an unreadable CLAUDE.md does not say it is missing', (t) => {
  const dir = repo(t, { 'CLAUDE.md': 'Run the tests before you commit.\n' });
  const r = cliDenied([dir, '--agents', 'claude'], path.join(dir, 'CLAUDE.md'));
  assert.doesNotMatch(r.stdout, /claude: not checked|no instruction or config files/);
  assert.doesNotMatch(r.stdout, /No findings|Nothing was checked/);
  assert.match(r.stdout, /could not be read \(EACCES\)/);
  assert.equal(r.status, 1);
});
