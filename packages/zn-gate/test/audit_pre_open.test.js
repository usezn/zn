'use strict';
// `zn audit --pre-open`: ZNA024 (git config that runs a program), ZNA025 (nested bare
// repository), ZNA026 (tool-named executable in bin/.bin). Fixtures are inert and fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { audit } = require('../lib/audit');
const cli = require('../lib/audit/cli');
const report = require('../lib/audit/report');
const { parseGitConfig } = require('../lib/audit/preopen');

// A value no report may ever contain.
const MARK = 'zn-fake-marker-9f3a';

function build(t, files) {
  const dir = tempDir(t, 'zn-audit-pre-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const gitCfg = (body) => '[core]\n\trepositoryformatversion = 0\n' + body;
const run = (dir, extra) => audit(Object.assign({ root: dir, env: {}, preOpen: true }, extra || {}));
const ids = (r) => r.findings.map((f) => f.id + ' ' + f.file + ':' + f.line);

const SINGLES = {
  fsmonitor: ['[core]\n\tfsmonitor = ' + MARK + '\n', 'core.fsmonitor'],
  sshCommand: ['[core]\n\tsshCommand = ' + MARK + '\n', 'core.sshCommand'],
  pager: ['[core]\n\tpager = ' + MARK + '\n', 'core.pager'],
  editor: ['[core]\n\teditor = ' + MARK + '\n', 'core.editor'],
  diffExternal: ['[diff]\n\texternal = ' + MARK + '\n', 'diff.external'],
  diffTextconv: ['[diff "x"]\n\ttextconv = ' + MARK + '\n', 'diff.<name>.textconv'],
  mergeDriver: ['[merge "x"]\n\tdriver = ' + MARK + ' %O\n', 'merge.<name>.driver'],
  mergetool: ['[mergetool "x"]\n\tcmd = ' + MARK + '\n', 'mergetool.<name>.cmd'],
  filter: ['[filter "x"]\n\tsmudge = ' + MARK + '\n', 'filter.<name>.smudge'],
  credential: ['[credential]\n\thelper = ' + MARK + '\n', 'credential.helper'],
  credentialUrl: ['[credential "https://example.invalid"]\n\thelper = ' + MARK + '\n', 'credential.<name>.helper'],
  hooksPath: ['[core]\n\thooksPath = .githooks\n', 'core.hooksPath'],
  include: ['[include]\n\tpath = ../extra.inc\n', 'include.path'],
  includeIf: ['[includeIf "gitdir:~/x/"]\n\tpath = ../extra.inc\n', 'includeIf.<condition>.path'],
};

for (const [name, [body, key]] of Object.entries(SINGLES)) {
  test('ZNA024 fires on a minimal fake config: ' + name, (t) => {
    const dir = build(t, { '.git/config': gitCfg(body), 'README.md': '#\n' });
    const r = run(dir);
    const f = r.findings.filter((x) => x.id === 'ZNA024');
    assert.equal(f.length, 1, JSON.stringify(ids(r)));
    assert.equal(f[0].file, '.git/config');
    assert.equal(f[0].severity, 'high');
    assert.ok(f[0].line >= 3);
    assert.ok(f[0].detail.includes(key), f[0].detail);
    assert.ok(!JSON.stringify(r).includes(MARK), 'the value was printed');
  });
}

test('ZNA024 does not fire on an ordinary clone config', (t) => {
  const dir = build(t, {
    '.git/config': gitCfg('\tbare = false\n\tfsmonitor = false\n\tpager = true\n[remote "origin"]\n\turl = https://example.invalid/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n[credential]\n\thelper =\n[core "x"]\n\tfoo = bar\n[pager]\n\tlog = false\n'),
    '.git/HEAD': 'ref: refs/heads/main\n',
    'README.md': '#\n',
  });
  const r = run(dir);
  assert.deepEqual(ids(r), []);
});

test('hooksPath and include that stay outside the folder are not reported', (t) => {
  const dir = build(t, { '.git/config': gitCfg('\thooksPath = /usr/share/fake-hooks\n[include]\n\tpath = ~/.gitconfig-fake\n[user]\n\tname = x\n') });
  assert.deepEqual(ids(run(dir)), []);
});

test('without --pre-open the new rules do not run', (t) => {
  const dir = build(t, { '.git/config': gitCfg(SINGLES.fsmonitor[0]), 'bin/git': '#!/bin/sh\n', 'sub/HEAD': 'x', 'sub/objects/a': 'x', 'sub/refs/a': 'x' });
  const r = audit({ root: dir, env: {} });
  assert.ok(!r.findings.some((f) => ['ZNA024', 'ZNA025', 'ZNA026'].includes(f.id)), JSON.stringify(ids(r)));
});

test('config parser: sections, old subsection syntax, quotes, comments, continuation', () => {
  const e = parseGitConfig('[Core]\n  EditoR = "a ; b" ; note\n[diff.old]\n  command = x \\\n  y\n# c\n[merge "s p"] driver = z\n');
  assert.deepEqual(e.map((x) => [x.section, x.sub, x.name]), [['core', null, 'editor'], ['diff', 'old', 'command'], ['merge', 's p', 'driver']]);
  assert.equal(e[0].value, 'a ; b');
  assert.equal(e[0].line, 2);
  assert.equal(e[1].line, 4);
});

test('ZNA025: a nested bare repository fires, its config is read, and no value is printed', (t) => {
  const dir = build(t, {
    'vendor/lib.git/HEAD': 'ref: refs/heads/main\n',
    'vendor/lib.git/objects/.keep': '',
    'vendor/lib.git/refs/.keep': '',
    'vendor/lib.git/config': '[core]\n\tbare = true\n\tfsmonitor = ' + MARK + '\n',
    'README.md': '#\n',
  });
  const r = run(dir);
  assert.ok(r.findings.some((f) => f.id === 'ZNA025' && f.file === 'vendor/lib.git' && f.severity === 'high'), JSON.stringify(ids(r)));
  assert.ok(r.findings.some((f) => f.id === 'ZNA024' && f.file === 'vendor/lib.git/config' && f.line === 3), JSON.stringify(ids(r)));
  assert.ok(!JSON.stringify(r).includes(MARK));
});

test('ZNA025 does not fire on a normal repository, a nested .git folder or loose names', (t) => {
  const dir = build(t, {
    '.git/HEAD': 'ref: refs/heads/main\n', '.git/objects/.keep': '', '.git/refs/.keep': '', '.git/config': gitCfg(''),
    'sub/.git/config': gitCfg('\tbare = false\n'), 'sub/.git/HEAD': 'x',
    'docs/HEAD': 'a', 'docs/refs/a': 'b',
  });
  assert.deepEqual(ids(run(dir)), []);
});

test('ZNA024 also reads the config of a nested repository', (t) => {
  const dir = build(t, { 'pkg/.git/config': gitCfg(SINGLES.pager[0]) });
  const r = run(dir);
  assert.ok(r.findings.some((f) => f.id === 'ZNA024' && f.file === 'pkg/.git/config'), JSON.stringify(ids(r)));
});

test('ZNA026 fires for a tool-named file in bin or .bin, not for other names', (t) => {
  const dir = build(t, { 'bin/node': '#!/bin/sh\n', 'bin/tool.sh': '#!/bin/sh\n', '.bin/git.exe': 'MZ', 'bin/dev': '#!/bin/sh\n', 'scripts/git': '#!/bin/sh\n' });
  const r = run(dir);
  const f = r.findings.filter((x) => x.id === 'ZNA026');
  assert.deepEqual(f.map((x) => x.file).sort(), ['.bin/git.exe', 'bin/node']);
  assert.equal(f.find((x) => x.file === '.bin/git.exe').severity, 'high');
  assert.equal(f.find((x) => x.file === 'bin/node').severity, 'medium');
  assert.ok(!r.findings.some((x) => x.id === 'ZNA016'));
});

function canLink(t) {
  const d = tempDir(t, 'zn-audit-lnk-');
  try { fs.symlinkSync(d, path.join(d, 'probe'), 'dir'); return true; } catch (_) { return false; }
}

test('symbolic links out of the tree are not followed', (t) => {
  if (!canLink(t)) return t.skip('symlinks not available');
  const outside = build(t, {
    'HEAD': 'ref: refs/heads/main\n', 'objects/.keep': '', 'refs/.keep': '',
    'config': '[core]\n\tfsmonitor = ' + MARK + '\n',
    'cfg': gitCfg(SINGLES.pager[0]),
    'node': '#!/bin/sh\n',
  });
  const dir = build(t, { 'README.md': '#\n' });
  fs.symlinkSync(outside, path.join(dir, 'linked'), 'dir');
  fs.symlinkSync(outside, path.join(dir, 'bin'), 'dir');
  const r = run(dir);
  assert.deepEqual(ids(r).filter((x) => /ZNA02[456]/.test(x)), []);

  // .git/config as a link is reported as not checked, never read
  const dir2 = build(t, { '.git/HEAD': 'x\n' });
  fs.symlinkSync(path.join(outside, 'cfg'), path.join(dir2, '.git', 'config'));
  const r2 = run(dir2);
  assert.ok(r2.findings.some((f) => f.id === 'ZNA020' && f.file === '.git/config' && f.severity === 'high'), JSON.stringify(ids(r2)));
  assert.ok(!r2.findings.some((f) => f.id === 'ZNA024'));
  // an include that resolves outside the tree is not a finding; a link in bin is skipped
  const dir3 = build(t, { 'bin/x': 'x' });
  fs.rmSync(path.join(dir3, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir3, 'bin'));
  fs.symlinkSync(path.join(outside, 'node'), path.join(dir3, 'bin', 'node'));
  assert.deepEqual(ids(run(dir3)), []);
});

test('an oversized .git/config is reported as not checked, not read', (t) => {
  const dir = build(t, { '.git/config': '#'.repeat(1024 * 1024 + 10) });
  const r = run(dir);
  assert.ok(r.findings.some((f) => f.id === 'ZNA020' && f.file === '.git/config'), JSON.stringify(ids(r)));
});

test('a .git file (worktree pointer) is reported as not followed', (t) => {
  const dir = build(t, { '.git': 'gitdir: ../elsewhere\n' });
  const r = run(dir);
  assert.ok(r.findings.some((f) => f.id === 'ZNA020' && f.file === '.git' && f.severity === 'medium'), JSON.stringify(ids(r)));
});

test('the existing agent-config rules still run with --pre-open (reused, not duplicated)', (t) => {
  const dir = build(t, { '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }), '.git/config': gitCfg('') });
  const r = run(dir);
  assert.ok(r.findings.some((f) => f.id === 'ZNA001'));
});

test('JSON and SARIF reports include the new rules and never a value', (t) => {
  const dir = build(t, {
    '.git/config': gitCfg(SINGLES.fsmonitor[0]),
    'n.git/HEAD': 'x', 'n.git/objects/.keep': '', 'n.git/refs/.keep': '',
    'bin/python': '#!/bin/sh\n',
  });
  const result = run(dir);
  const meta = { toolVersion: '0.0.0', failOn: 'high', displayRoot: '.' };
  const json = JSON.parse(report.toJson(result, meta));
  const jids = new Set(json.findings.map((f) => f.id));
  for (const id of ['ZNA024', 'ZNA025', 'ZNA026']) assert.ok(jids.has(id), id);
  const sarif = JSON.parse(report.toSarif(result, meta));
  const driver = sarif.runs[0].tool.driver;
  for (const id of ['ZNA024', 'ZNA025', 'ZNA026']) assert.ok(driver.rules.some((r) => r.id === id), id);
  const sids = new Set(sarif.runs[0].results.map((x) => x.ruleId));
  for (const id of ['ZNA024', 'ZNA025', 'ZNA026']) assert.ok(sids.has(id), id);
  assert.ok(!report.toText(result, Object.assign({ color: false }, meta)).includes(MARK));
  assert.ok(!JSON.stringify(sarif).includes(MARK));
});

test('cli: --pre-open is parsed, listed in the usage and changes the result', async (t) => {
  assert.equal(cli.parseArgs(['--pre-open']).preOpen, true);
  assert.equal(cli.parseArgs([]).preOpen, false);
  assert.match(cli.USAGE, /--pre-open/);
  const dir = build(t, { '.git/config': gitCfg(SINGLES.fsmonitor[0]) });
  const sink = () => { let s = ''; return { write: (x) => { s += x; }, get text() { return s; } }; };
  const a = sink(); const b = sink();
  const codePlain = await cli.main([dir, '--format', 'json'], { stdout: a, stderr: sink(), cwd: dir, env: {}, home: dir });
  const codePre = await cli.main([dir, '--format', 'json', '--pre-open'], { stdout: b, stderr: sink(), cwd: dir, env: {}, home: dir });
  assert.equal(codePlain, 0);
  assert.equal(codePre, 1);
  assert.ok(!b.text.includes(MARK));
  assert.ok(JSON.parse(b.text).findings.some((f) => f.id === 'ZNA024'));
});
