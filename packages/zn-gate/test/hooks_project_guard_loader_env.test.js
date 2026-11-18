'use strict';
process.env.ZN_STATS = 'off';

// The project hook guard (the sh -c command, the Antigravity split form and the PowerShell script) starts the `zn` on the
// PATH with the agent's environment, which a project can set. NODE_OPTIONS=--require and the other loader variables must be
// gone before zn (a Node.js program) starts. Every value here is a benign marker: a preload that only writes a marker file
// and a stand-in zn that starts Node.js and reports the variables it got. Nothing destructive is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const launcher = require('../lib/agents/launcher');
const loaderEnv = require('../lib/loader-env');
const { tempDir } = require('./helpers/tmp');

const skip = { skip: process.platform === 'win32' };
const shellArgs = (sh) => (/(^|\/)bash$/.test(sh) ? ['--norc', '--noprofile'] : []);

function whichSh() {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, 'sh');
    if (d && fs.existsSync(f)) return fs.realpathSync(f);
  }
  return '/bin/sh';
}

/* <root>/<sub> holds sh, node and a zn that runs Node.js, which records the loader-related names it got. */
function mkbin(t, sub = 'bin') {
  const root = tempDir(t, 'zn-guard-env-');
  const bin = path.join(root, sub);
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(root, 'marker');
  const seen = path.join(root, 'seen.json');
  const pre = path.join(root, 'pre.cjs');
  fs.writeFileSync(pre, "require('fs').appendFileSync(" + JSON.stringify(marker) + ", 'preloaded\\n');\n");
  fs.symlinkSync(whichSh(), path.join(bin, 'sh'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const code = "require('fs').writeFileSync(" + JSON.stringify(seen) + ", JSON.stringify(Object.keys(process.env).filter((k) => /^(node_|ld_|https_proxy$)/i.test(k)).sort()))";
  fs.writeFileSync(path.join(bin, 'zn'), '#!' + whichSh() + '\nexec ' + JSON.stringify(path.join(bin, 'node')) + ' -e ' + JSON.stringify(code) + '\n');
  fs.chmodSync(path.join(bin, 'zn'), 0o755);
  const env = {
    // The system folders come after the test folder: the guard reads real paths with readlink -f or realpath.
    PATH: bin + ':/usr/bin:/bin',
    NODE_OPTIONS: '--require ' + pre,
    Node_Options: '--require ' + pre,
    NODE_PATH: root,
    NODE_EXTRA_CA_CERTS: path.join(root, 'ca.pem'),
    HTTPS_PROXY: 'http://proxy.example.invalid:3128',
  };
  return { bin, marker, seen, env };
}

const forms = {
  'sh -c (agents that run a shell)': (bin, env) => {
    const cmd = launcher.projectShCommand('claude-code', 'PreToolUse');
    const script = cmd.slice(6).replace(/^'|'$/g, '').replace(/'\\''/g, "'");
    return spawnSync(path.join(bin, 'sh'), [...shellArgs(whichSh()), '-c', script], { input: '{}', encoding: 'utf8', env, cwd: '/' });
  },
  'split-on-spaces form (Antigravity)': (bin, env) => {
    const parts = launcher.projectShCommand('antigravity').split(' ');
    return spawnSync(path.join(bin, parts[0]), parts.slice(1), { input: '{}', encoding: 'utf8', env, cwd: '/' });
  },
};

test('sanity: the stand-in zn does load the preload when started with the hostile environment directly', skip, (t) => {
  const b = mkbin(t);
  const r = spawnSync(path.join(b.bin, 'zn'), [], { encoding: 'utf8', env: b.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(b.marker, 'utf8'), /preloaded/);
});

for (const [name, run] of Object.entries(forms)) {
  test('project guard, ' + name + ': NODE_OPTIONS and NODE_PATH do not reach zn, and zn still runs', skip, (t) => {
    const b = mkbin(t);
    const r = run(b.bin, b.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(b.marker), false, 'a preload ran inside the hook');
    const got = JSON.parse(fs.readFileSync(b.seen, 'utf8'));
    // The Antigravity form has no loop (no spaces, so no shell keywords): it unsets the names as written. Node.js reads only
    // NODE_OPTIONS on Linux and macOS, so a Node_Options left there loads nothing (the marker check above holds for both).
    const names = name.startsWith('split') ? /^NODE_(OPTIONS|PATH)$/ : /^node_(options|path)$/i;
    assert.ok(!got.some((k) => names.test(k)), JSON.stringify(got));
    assert.ok(got.includes('HTTPS_PROXY') && got.includes('NODE_EXTRA_CA_CERTS'), 'CA and proxy settings stay: ' + JSON.stringify(got));
  });
  test('project guard, ' + name + ': a zn in a Node_Modules folder (any case) is not run', skip, (t) => {
    const b = mkbin(t, path.join('Node_Modules', '.bin'));
    run(b.bin, { PATH: b.bin + ':/usr/bin:/bin' });
    assert.equal(fs.existsSync(b.seen), false, 'the zn in Node_Modules ran');
  });
}

test('project guard, sh -c form: the shared scrub comes first, and the guard is still recognised', () => {
  for (const e of [undefined, 'PreToolUse', 'beforeShellExecution']) {
    const agent = e === 'beforeShellExecution' ? 'cursor' : 'claude-code';
    const cmd = launcher.projectShCommand(agent, e);
    const unset = 'unset ' + loaderEnv.LOADER_NAMES.join(' ');
    assert.ok(cmd.startsWith("sh -c '" + unset + '\n'), cmd.slice(0, 80));
    assert.ok(cmd.indexOf('command -v zn') > cmd.indexOf('set +f'), 'the scrub ends before zn is looked for');
    assert.equal(launcher.isProjectGuard(cmd, agent), true);
    assert.equal(launcher.isProjectGuardExact(cmd, agent), true);
  }
  const ag = launcher.projectShCommand('antigravity');
  assert.ok(!/\s/.test(ag.slice(6)), 'the Antigravity form holds no space');
  assert.ok(ag.includes('unset${IFS}NODE_OPTIONS${IFS}') || ag.includes('NODE_OPTIONS'), 'NODE_OPTIONS is unset');
  assert.ok(ag.indexOf('NODE_OPTIONS') < ag.indexOf('hook'), 'before zn starts');
  assert.equal(launcher.isProjectGuard(ag, 'antigravity'), true);
});

test('project guard, PowerShell form (static: not run on Windows here): the loader variables are removed before zn.cmd starts', () => {
  for (const [agent, e] of [['claude-code', 'PreToolUse'], ['cursor', 'beforeShellExecution'], ['gemini', 'BeforeTool'], ['copilot', 'preToolUse']]) {
    const s = launcher.projectWindowsScript(agent, e);
    const at = s.indexOf(loaderEnv.psScrub());
    assert.ok(at > 0, agent + ': the scrub is in the script');
    assert.ok(at < s.indexOf("(zf 'zn.cmd')"), agent + ': before zn.cmd is looked for');
    assert.equal(launcher.isProjectWindowsScript(s, agent), true, agent);
    assert.ok(launcher.windowsScriptCommand(s).length < 8191, agent);
  }
});
