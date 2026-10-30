'use strict';

// zn-gate reach --history: scans the local session histories of the agents for secrets and reports a closed
// vocabulary only (agent, file, type, count, action). No value, part of a value or hash is ever printed.
// All values below are obviously fake and are put together at run time.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { history, report } = require('../lib/reach/history');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

// The AWS documentation example key, and fake keys that only have the shape of the real ones.
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const OPENAI = 'sk-' + 'test-FAKE' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7';
const GITHUB = 'gh' + 'p_' + 'FAKE0123456789abcdefFAKE0123456789ab';
const ANTHROPIC = 'sk-' + 'ant-api03-' + 'FAKE0123456789abcdefFAKE0123456789abcdef-FAKE';
const FAKES = [AWS, OPENAI, GITHUB, ANTHROPIC];

function jsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function machine(t) {
  const home = tempDir(t, 'zn-hist-home-');
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath), ZN_STATS: 'off' };
  return { home, env };
}

function put(home, rel, text) {
  const abs = path.join(home, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

// Fails when the output holds a fake value, or any run of 8 or more characters of one.
function assertNoSecret(output) {
  for (const v of FAKES) {
    assert.ok(!output.includes(v), 'a whole value is in the output');
    for (let i = 0; i + 8 <= v.length; i++) assert.ok(!output.includes(v.slice(i, i + 8)), 'a fragment of a value is in the output');
  }
}

function claudeFixture(home) {
  put(home, '.claude/projects/-proj-a/sess1.jsonl', jsonl([
    { type: 'user', message: { role: 'user', content: 'deploy with ' + AWS + ' please' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok, key ' + AWS + ' and token ' + GITHUB }] } },
    { type: 'user', message: { content: 'nothing here' } },
  ]));
  put(home, '.claude/projects/-proj-a/sess2.jsonl', jsonl([{ type: 'user', message: { content: 'clean session' } }]));
  put(home, '.claude/history.jsonl', jsonl([{ display: 'export OPENAI_API_KEY=' + OPENAI }]));
  put(home, '.codex/sessions/2026/10/30/rollout-2026-10-30T10-00-00-abc.jsonl', jsonl([
    { type: 'response_item', payload: { type: 'message', content: [{ type: 'input_text', text: 'my key is ' + ANTHROPIC }] } },
  ]));
}

test('finds secrets in Claude Code and Codex histories and reports type and count only', (t) => {
  const { home, env } = machine(t);
  claudeFixture(home);
  const r = history({ home, env });
  assert.equal(r.tool, 'zn-gate reach --history');
  assert.equal(r.version, 1);
  const f = (agent, file, type) => r.findings.find((x) => x.agent === agent && x.file === file && x.type === type);
  assert.equal(f('claude-code', '~/.claude/projects/-proj-a/sess1.jsonl', 'AWS_KEY').count, 2);
  assert.equal(f('claude-code', '~/.claude/projects/-proj-a/sess1.jsonl', 'GITHUB_TOKEN').count, 1);
  assert.equal(f('claude-code', '~/.claude/history.jsonl', 'OPENAI_KEY').count, 1);
  assert.equal(f('codex', '~/.codex/sessions/2026/10/30/rollout-2026-10-30T10-00-00-abc.jsonl', 'ANTHROPIC_KEY').count, 1);
  assert.ok(!r.findings.some((x) => x.file.endsWith('sess2.jsonl')));
  assert.match(f('claude-code', '~/.claude/projects/-proj-a/sess1.jsonl', 'AWS_KEY').action, /^Rotate this AWS access key .*delete this session file/);
  assert.equal(r.totals.files_scanned, 4);
  assert.equal(r.totals.files_with_secrets, 3);
  assert.equal(r.totals.secrets, 5);
  assert.equal(r.time_limit_hit, false);
  assert.deepEqual(r.incomplete, []);
  assert.ok(r.notes.some((n) => /already be rotated/.test(n)));
  assert.ok(r.notes.some((n) => /already sent to your model provider/.test(n)));
  const ids = r.agents.map((a) => a.id);
  assert.deepEqual(ids, ['claude-code', 'codex', 'cursor', 'opencode']);
  assert.equal(r.agents.find((a) => a.id === 'cursor').reason, 'database');
});

test('no output format holds a secret value or a part of one', (t) => {
  const { home, env } = machine(t);
  claudeFixture(home);
  const r = history({ home, env });
  let text = '';
  report(r, (s) => { text += s; });
  assertNoSecret(text);
  assertNoSecret(JSON.stringify(r));
  const cli = spawnSync(process.execPath, [CLI, 'reach', '--history'], { encoding: 'utf8', env });
  assert.equal(cli.status, 0);
  assertNoSecret(cli.stdout + cli.stderr);
  const cliJson = spawnSync(process.execPath, [CLI, 'reach', '--history', '--json'], { encoding: 'utf8', env });
  assert.equal(cliJson.status, 0);
  assertNoSecret(cliJson.stdout + cliJson.stderr);
  assert.match(cli.stdout, /AWS_KEY/);
});

test('--json has a stable schema', (t) => {
  const { home, env } = machine(t);
  claudeFixture(home);
  const cli = spawnSync(process.execPath, [CLI, 'reach', '--history', '--json'], { encoding: 'utf8', env });
  const r = JSON.parse(cli.stdout);
  assert.deepEqual(Object.keys(r).sort(), ['agents', 'elapsed_ms', 'findings', 'incomplete', 'max_seconds', 'notes', 'time_limit_hit', 'tool', 'totals', 'version']);
  assert.deepEqual(Object.keys(r.agents[0]).sort(), ['bytes', 'files', 'id', 'name', 'reason', 'scanned']);
  assert.deepEqual(Object.keys(r.findings[0]).sort(), ['action', 'agent', 'count', 'file', 'type']);
  assert.deepEqual(Object.keys(r.totals).sort(), ['bytes_scanned', 'files_not_reached', 'files_scanned', 'files_with_secrets', 'secrets']);
  for (const f of r.findings) {
    assert.match(f.type, /^[A-Z0-9_]+$/);
    assert.ok(Number.isInteger(f.count) && f.count > 0);
  }
});

test('a clean home folder reports nothing and writes nothing', (t) => {
  const { home, env } = machine(t);
  put(home, '.claude/projects/p/s.jsonl', jsonl([{ type: 'user', message: { content: 'hello' } }]));
  const r = history({ home, env });
  assert.deepEqual(r.findings, []);
  let text = '';
  report(r, (s) => { text += s; });
  assert.match(text, /No secret found/);
  assert.match(text, /cannot see what was already sent to your model provider/);
  // Nothing was written: no evidence log, no memory file.
  assert.deepEqual(fs.readdirSync(home).sort(), ['.claude']);
});

test('a secret already replaced by a zn marker is not counted', (t) => {
  const { home, env } = machine(t);
  put(home, '.claude/projects/p/s.jsonl', jsonl([{ type: 'user', message: { content: 'key __ZN_AWS_KEY_1__ and __ZN_REDACTED_OPENAI_KEY__' } }]));
  assert.deepEqual(history({ home, env }).findings, []);
});

test('a line longer than one read chunk is scanned whole', (t) => {
  const { home, env } = machine(t);
  const pad = 'x '.repeat(750000);
  put(home, '.codex/sessions/s.jsonl', jsonl([{ text: pad + ' ' + AWS + ' ' + pad }, { text: AWS }]));
  const r = history({ home, env });
  assert.equal(r.findings.find((f) => f.type === 'AWS_KEY').count, 2);
});

test('plain text lines that are not JSON are scanned too', (t) => {
  const { home, env } = machine(t);
  put(home, '.claude/history.jsonl', 'not json: ' + AWS + '\n{broken ' + GITHUB + '\n');
  const r = history({ home, env });
  assert.deepEqual(r.findings.map((f) => f.type).sort(), ['AWS_KEY', 'GITHUB_TOKEN']);
});

test('links are never followed out of the home folder', (t) => {
  const { home, env } = machine(t);
  const outside = tempDir(t, 'zn-hist-outside-');
  put(outside, 'x/stolen.jsonl', jsonl([{ text: AWS }]));
  put(outside, 'secret.jsonl', jsonl([{ text: GITHUB }]));
  try {
    fs.mkdirSync(path.join(home, '.claude/projects/p'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'x'), path.join(home, '.claude/projects/linkdir'), 'dir');
    fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(home, '.claude/projects/p/linkfile.jsonl'));
    fs.symlinkSync(outside, path.join(home, '.codex'), 'dir');
  } catch (_) {
    t.skip('symbolic links are not allowed here');
    return;
  }
  const r = history({ home, env });
  assert.deepEqual(r.findings, []);
  const reasons = r.incomplete.map((i) => i.file + ' ' + i.reason).sort();
  assert.deepEqual(reasons, ['~/.claude/projects/linkdir symlink', '~/.claude/projects/p/linkfile.jsonl symlink', '~/.codex symlink']);
  assert.equal(r.agents.find((a) => a.id === 'codex').scanned, false);
});

test('a config folder named by the environment outside the home folder is ignored', (t) => {
  const { home, env } = machine(t);
  const outside = tempDir(t, 'zn-hist-outside-');
  put(outside, 'projects/p/s.jsonl', jsonl([{ text: AWS }]));
  assert.deepEqual(history({ home, env: { ...env, CLAUDE_CONFIG_DIR: outside } }).findings, []);
  put(home, 'cfg/projects/p/s.jsonl', jsonl([{ text: AWS }]));
  const r = history({ home, env: { ...env, CLAUDE_CONFIG_DIR: path.join(home, 'cfg') } });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].file, '~/cfg/projects/p/s.jsonl');
});

test('when the time limit is reached the files not fully scanned are listed', (t) => {
  const { home, env } = machine(t);
  claudeFixture(home);
  const r = history({ home, env, _maxMs: -1 });
  assert.equal(r.time_limit_hit, true);
  assert.equal(r.totals.files_scanned, 0);
  assert.equal(r.totals.files_not_reached, 4);
  assert.equal(r.incomplete.length, 4);
  assert.ok(r.incomplete.every((i) => i.reason === 'time-limit'));
  let text = '';
  report(r, (s) => { text += s; });
  assert.match(text, /NOT FULLY SCANNED/);
  assert.match(text, /time limit was reached/);
  assert.doesNotMatch(text, /No secret found/);
});

test('usage errors', (t) => {
  const { env } = machine(t);
  const run = (...a) => spawnSync(process.execPath, [CLI, 'reach', ...a], { encoding: 'utf8', env });
  for (const bad of [['--history', '.'], ['--history', '--sarif'], ['--history', '--remember'], ['--history', '--fail-on', 'high'],
    ['--history', '--max-seconds', '0'], ['--history', '--max-seconds', 'x'], ['--max-seconds', '5']]) {
    const r = run(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /usage: zn-gate reach/);
  }
  assert.equal(run('--history', '--max-seconds', '5').status, 0);
});

// A 300 MB history made at run time and never kept. Opt in with ZN_HISTORY_BIG=1: it takes a while.
test('a 300 MB history is scanned in streaming mode', { skip: process.env.ZN_HISTORY_BIG !== '1' }, (t) => {
  const { home, env } = machine(t);
  const file = path.join(home, '.claude/projects/big/huge.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const body = 'lorem ipsum dolor sit amet consectetur '.repeat(100);
  const plain = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: body }] } }) + '\n';
  const withKey = JSON.stringify({ type: 'user', message: { content: body + AWS } }) + '\n';
  let written = 0;
  let keys = 0;
  for (let i = 0; written < 300 * 1024 * 1024; i++) {
    const line = i % 5000 === 0 ? (keys++, withKey) : plain;
    fs.writeSync(fd, line);
    written += line.length;
  }
  fs.closeSync(fd);
  const before = process.memoryUsage().rss;
  const r = history({ home, env, maxSeconds: 900 });
  const rssGrowthMb = (process.memoryUsage().rss - before) / 1048576;
  process.stderr.write('big history: ' + (written / 1048576).toFixed(0) + ' MB in ' + r.elapsed_ms + ' ms, rss growth ' + rssGrowthMb.toFixed(0) + ' MB\n');
  assert.equal(r.findings.find((f) => f.type === 'AWS_KEY').count, keys);
  assert.equal(r.incomplete.length, 0);
  assert.ok(r.totals.bytes_scanned >= 300 * 1024 * 1024);
  assert.ok(rssGrowthMb < 400);
});
