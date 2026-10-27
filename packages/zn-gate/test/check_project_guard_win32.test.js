'use strict';
process.env.ZN_STATS = 'off';

// On Windows a project install writes the project guard as an encoded PowerShell command, so the agent's hooks file holds no
// plain "zn". `zn-gate check` must still see that guard: project-only for the guard, not-protected for a bare `zn hook`.
// Windows is simulated in a child process (process.platform is set there only), with a fixed path for powershell.exe.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const ROOT = path.join(__dirname, '..');

const SIM = `
Object.defineProperty(process, 'platform', { value: 'win32' });
const path = require('path');
const [root, home, agent, guarded, bare] = process.argv.slice(1);
require(path.join(root, 'lib', 'exe')).systemPowerShell = () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const { getAdapter } = require(path.join(root, 'lib', 'agents'));
const { check } = require(path.join(root, 'lib', 'check'));
const base = { home, env: { HOME: home }, mcp: false, managedDir: path.join(home, 'no-managed-policy') };
getAdapter(agent).install({ ...base, scope: 'project', projectDir: guarded });
getAdapter(agent).install({ ...base, scope: 'project', projectDir: bare, command: 'zn hook ' + agent });
(async () => {
  const env = { HOME: home, PATH: process.env.PATH };
  const find = (res) => (res.results || res).find((x) => x.id === agent);
  const g = find(await check({ home, env, cwd: guarded }));
  const b = find(await check({ home, env, cwd: bare }));
  process.stdout.write(JSON.stringify({ guarded: g.state, bare: b.state, bareProblem: b.problem || '' }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`;

for (const agent of ['cursor', 'gemini', 'copilot']) {
  test('check (Windows simulated): the guarded project hook of ' + agent + ' is project-only, a bare `zn hook` is not protected', (t) => {
    const home = tempDir(t, 'zn-psg-home-');
    // Windows takes the temporary folder from TEMP and TMP, which Linux does not set.
    const tmp = tempDir(t, 'zn-psg-tmp-');
    const r = spawnSync(process.execPath, ['-e', SIM, ROOT, home, agent, tempDir(t, 'zn-psg-g-'), tempDir(t, 'zn-psg-b-')],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, ZN_STATS: 'off', TEMP: tmp, TMP: tmp } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.guarded, 'project-only', agent + ' ' + r.stdout);
    assert.equal(out.bare, 'not-protected', agent + ' ' + r.stdout);
    assert.match(out.bareProblem, /bare `zn hook /, agent);
  });
}
