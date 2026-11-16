'use strict';
process.env.ZN_STATS = 'off';

// On Windows, `zn hooks install claude-code` writes zn's sh launcher as the hook command, and Claude Code runs it with Git Bash.
// Without Git Bash the hooks cannot start, so a plain `zn-gate check` and `check --json` must say "not protected", as
// `check --hooks` does, and name Git for Windows as the fix; `hooks install` must warn. Windows is simulated: the decision
// functions take the platform, and the end-to-end case runs in a child process where only process.platform is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const ROOT = path.join(__dirname, '..');
const { launcherNeedsMissingGitBash, NEEDS_GIT_BASH_FIX } = require('../lib/check')._internal;
const { noGitBashWarning } = require('../lib/agents/claude-code');

test('launcherNeedsMissingGitBash: the sh launcher on Windows with no Git Bash on the PATH', (t) => {
  const empty = tempDir(t, 'zn-nogb-path-');
  const env = { PATH: empty };
  const sh = { launcher: 'C:/Users/u/.zn/hooks/zn-hook-claude-code.sh', event: 'PreToolUse' };
  assert.equal(launcherNeedsMissingGitBash(sh, env, 'win32'), true);
  // Not Windows: the launcher runs by itself.
  assert.equal(launcherNeedsMissingGitBash(sh, env, 'linux'), false);
  // The inline PowerShell hook of the other agents needs no Git Bash.
  assert.equal(launcherNeedsMissingGitBash({ ...sh, winScript: 'Write-Output 1' }, env, 'win32'), false);
  // Not a launcher at all.
  assert.equal(launcherNeedsMissingGitBash({ onPath: true }, env, 'win32'), false);
});

test('launcherNeedsMissingGitBash: CLAUDE_CODE_GIT_BASH_PATH naming a file counts as Git Bash', (t) => {
  const dir = tempDir(t, 'zn-nogb-bash-');
  const bash = path.join(dir, 'bash.exe');
  fs.writeFileSync(bash, '');
  const env = { PATH: tempDir(t, 'zn-nogb-path-'), CLAUDE_CODE_GIT_BASH_PATH: bash };
  assert.equal(launcherNeedsMissingGitBash({ launcher: 'C:/x/zn-hook-claude-code.sh' }, env, 'win32'), false);
  // A setting that names no file does not.
  assert.equal(launcherNeedsMissingGitBash({ launcher: 'C:/x/zn-hook-claude-code.sh' }, { ...env, CLAUDE_CODE_GIT_BASH_PATH: path.join(dir, 'gone.exe') }, 'win32'), true);
});

test('hooks install claude-code warns on Windows without Git Bash, and only there', (t) => {
  const env = { PATH: tempDir(t, 'zn-nogb-path-') };
  const w = noGitBashWarning({ platform: 'win32', env });
  assert.match(w, /^Git Bash was not found: on Windows, Claude Code runs these hooks with Git Bash/);
  assert.match(w, /zn does not protect Claude Code until you install Git for Windows/);
  assert.match(w, /CLAUDE_CODE_GIT_BASH_PATH/);
  assert.equal(noGitBashWarning({ platform: 'linux', env }), '');
  assert.equal(noGitBashWarning({ platform: 'win32', env, command: 'my-hook' }), '');
});

test('the fix names Git for Windows, never `zn hooks install` (it would write the same launcher)', () => {
  assert.match(NEEDS_GIT_BASH_FIX, /^install Git for Windows/);
  assert.doesNotMatch(NEEDS_GIT_BASH_FIX, /zn hooks install/);
});

// Install zn's hooks for Claude Code here (not Windows), then read them back as Windows with a PATH that has no Git Bash.
const SIM = `
const path = require('path');
const [root, home, emptyPath] = process.argv.slice(1);
const { getAdapter } = require(path.join(root, 'lib', 'agents'));
getAdapter('claude-code').install({ home, env: { HOME: home }, mcp: false, managedDir: path.join(home, 'no-managed-policy') });
Object.defineProperty(process, 'platform', { value: 'win32' });
require(path.join(root, 'lib', 'exe')).systemPowerShell = () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const check = require(path.join(root, 'lib', 'check'));
const hl = require(path.join(root, 'lib', 'hooks-list'));
(async () => {
  const env = { HOME: home, PATH: emptyPath };
  const res = await check.check({ home, env, cwd: home, live: false, managedDir: path.join(home, 'no-managed-policy') });
  const cc = res.results.find((x) => x.id === 'claude-code');
  const json = check.toJson(res, { home });
  const listed = hl.listHooks({ home, env, cwd: home });
  let text = '';
  hl.report(listed, (s) => { text += s; });
  const { plan } = require(path.join(root, 'lib', 'init-guide'));
  const { items } = await plan({ home, env, cwd: home, claude: null, temporary: false, ancestry: () => null });
  const steps = items.find((i) => i.id === 'claude-code').steps.map((s) => ({ label: s.label, run: s.run, manual: s.manual }));
  process.stdout.write(JSON.stringify({
    state: cc.state, problem: cc.problem || '', fix: cc.fix || '', needsGitBash: !!cc.needsGitBash,
    exitCode: check.exitCodeOf(res.results), jsonProtected: json.protected, jsonAgent: json.agents.find((a) => a.id === 'claude-code'),
    counts: listed.counts, hooksText: text, steps,
  }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`;

test('check (Windows simulated, no Git Bash): zn\'s Claude Code hooks are not protected in check, --json and --hooks alike', { skip: process.platform === 'win32' && 'simulates Windows on another system' }, (t) => {
  const home = tempDir(t, 'zn-nogb-home-');
  const tmp = tempDir(t, 'zn-nogb-tmp-');
  const empty = tempDir(t, 'zn-nogb-path-');
  const r = spawnSync(process.execPath, ['-e', SIM, ROOT, home, empty],
    { encoding: 'utf8', timeout: 90000, env: { ...process.env, ZN_STATS: 'off', TEMP: tmp, TMP: tmp, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'not-protected', r.stdout);
  assert.match(out.problem, /^its hook cannot start: Claude Code runs zn's hook launcher \(.+zn-hook-claude-code\.sh\) with Git Bash on Windows, and Git Bash was not found$/);
  assert.equal(out.fix, NEEDS_GIT_BASH_FIX);
  assert.equal(out.needsGitBash, true);
  assert.notEqual(out.exitCode, 0);
  assert.equal(out.jsonProtected, false);
  assert.equal(out.jsonAgent.protected, false);
  assert.equal(out.jsonAgent.state, 'not-protected');
  // check --hooks agrees: every Claude Code hook is BROKEN (cannot start), with Git for Windows as the fix.
  assert.equal(out.counts.ok, 0, r.stdout);
  assert.ok(out.counts.broken > 0, r.stdout);
  assert.match(out.hooksText, /Fix: install Git for Windows/);
  assert.doesNotMatch(out.hooksText, /Fix: run `zn(\.cmd)? hooks install claude-code`/);
  // init's plan: Git for Windows first, never `zn hooks install claude-code` again (it would write the same launcher).
  assert.deepEqual(out.steps, [{ label: 'first do this yourself', run: null, manual: NEEDS_GIT_BASH_FIX }]);
});
