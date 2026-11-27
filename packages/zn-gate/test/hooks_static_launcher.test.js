'use strict';
process.env.ZN_STATS = 'off';

// The static hook launcher (tools/hook-launcher, lib/agents/static-launcher.js) on Linux. With LD_TRACE_LOADED_OBJECTS (any value) or
// LD_DEBUG naming `help`, the dynamic loader prints text and exits 0 before the first line of any dynamically linked program, so a hook
// started through sh or node never runs, and Claude Code and ZCode read exit 0 with plain text as "no objection". The
// installed hook of each agent that can start a program with no shell is run here the way that agent runs it, with each of those
// variables and with a preload variable: every run must be the deny of that agent with its blocking exit code, and the hook must not
// run. A run with none of them must reach the hook, with no loader variable left in its environment. Nothing destructive is run: the
// hook is a stub that records that it ran.
//
// The e2e part needs the launcher built for this machine (cargo build --release --target x86_64-unknown-linux-musl in
// tools/hook-launcher); ZN_TEST_HOOK_LAUNCHER names it. Without it those tests are skipped, and the checks that need no binary still run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const loaderEnv = require('../lib/loader-env');
const sl = require('../lib/agents/static-launcher');
const { tempDir } = require('./helpers/tmp');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUST = path.join(ROOT, 'tools', 'hook-launcher', 'src', 'main.rs');
const KEY = sl.platformKey(process.platform, process.arch);
const BIN = process.env.ZN_TEST_HOOK_LAUNCHER || '';
const haveBin = Boolean(KEY) && Boolean(BIN) && fs.existsSync(BIN);
const e2eSkip = haveBin ? false : 'needs Linux and the launcher built for it (ZN_TEST_HOOK_LAUNCHER)';

// A stub runner: records that it ran and which loader variables reached it, confirms its answer like the real runner, answers nothing.
const RUNNER = "const fs = require('fs');" +
  "fs.appendFileSync(process.env.ZN_TEST_RAN, 'hook ran ' + process.argv.slice(2).join(' ') + '\\n');" +
  "fs.writeFileSync(process.env.ZN_TEST_SEEN, JSON.stringify(Object.keys(process.env).filter((k) => require(" + JSON.stringify(path.join(__dirname, '..', 'lib', 'loader-env.js')) + ").isLoaderVar(k))));" +
  "if (process.env.ZN_HOOK_ACK) fs.writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n";

function nativeDirWith(dir, bytes, sha) {
  const nd = path.join(dir, 'native');
  fs.mkdirSync(path.join(nd, KEY || 'linux-x64'), { recursive: true });
  fs.writeFileSync(path.join(nd, KEY || 'linux-x64', sl.NAME), bytes, { mode: 0o755 });
  fs.writeFileSync(path.join(nd, 'hook-launcher.json'), JSON.stringify({ [KEY || 'linux-x64']: sha || crypto.createHash('sha256').update(bytes).digest('hex') }));
  return nd;
}

function fixture(t) {
  const home = tempDir(t, 'zn-static-');
  const runner = path.join(home, 'runner.js');
  fs.writeFileSync(runner, RUNNER);
  const nativeDir = haveBin ? nativeDirWith(home, fs.readFileSync(BIN)) : path.join(home, 'no-native');
  return { home, runner, nativeDir, ran: path.join(home, 'ran.txt'), seen: path.join(home, 'seen.json') };
}

const opts = (f) => ({ home: f.home, env: { HOME: f.home }, nodePath: process.execPath, runnerPath: f.runner, nativeDir: f.nativeDir, mcp: false, managedDir: path.join(f.home, 'managed'), platform: 'linux' });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Per agent: install, the installed entry of its blocking event, and how a refusal looks.
const AGENTS = {
  'claude-code': {
    event: 'PreToolUse',
    install: (f) => require('../lib/agents/claude-code').install(opts(f)),
    entry: (f) => readJson(path.join(f.home, '.claude', 'settings.json')).hooks.PreToolUse.at(-1).hooks[0],
    denied: (r) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /run unset NAME in the terminal, remove its line/); },
  },
  zcode: {
    event: 'PreToolUse',
    install: (f) => require('../lib/agents/zcode').install(opts(f)),
    entry: (f) => readJson(path.join(f.home, '.zcode', 'cli', 'config.json')).hooks.events.PreToolUse.at(-1).hooks[0],
    denied: (r) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /run unset NAME in the terminal, remove its line/); },
  },
  antigravity: {
    event: 'PreToolUse',
    install: (f) => require('../lib/agents/antigravity').install(opts(f)),
    entry: (f) => {
      const data = readJson(path.join(f.home, '.gemini', 'config', 'hooks.json'));
      return Object.values(data).find((v) => v && v.PreToolUse).PreToolUse.at(-1).hooks[0].command;
    },
    denied: (r) => {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const o = JSON.parse(r.stdout);
      assert.equal(o.decision, 'deny');
      assert.match(o.reason, /run unset NAME in the terminal, remove its line/);
    },
  },
};

// Runs an installed entry the way its agent runs it: command + args (Claude Code exec form, ZCode
// process), a string split on spaces with no shell (Antigravity), or the shell form (sh -c) of a command string.
function runEntry(entry, f, extra) {
  const env = { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.home, ZN_STATS: 'off', ZN_TEST_RAN: f.ran, ZN_TEST_SEEN: f.seen, ...extra };
  const o = { input: '{}', encoding: 'utf8', env, timeout: 60000 };
  if (typeof entry === 'string') { const p = entry.split(' '); return spawnSync(p[0], p.slice(1), o); }
  if (Array.isArray(entry.args)) return spawnSync(entry.command, entry.args, o);
  return spawnSync('/bin/sh', ['-c', entry.bash || entry.command], o);
}

const STOPPING = [
  ['LD_TRACE_LOADED_OBJECTS=1', { LD_TRACE_LOADED_OBJECTS: '1' }],
  ['LD_TRACE_LOADED_OBJECTS=0', { LD_TRACE_LOADED_OBJECTS: '0' }],
  ['LD_DEBUG=help', { LD_DEBUG: 'help' }],
  ['LD_DEBUG=libs,help', { LD_DEBUG: 'libs,help' }],
  ['LD_PRELOAD=/example/x.so', { LD_PRELOAD: '/example/x.so' }],
];

for (const [id, a] of Object.entries(AGENTS)) {
  if (!sl.STATIC_ENABLED.includes(id)) continue; // the others are detection only on Linux: see the gating test below
  for (const [label, extra] of STOPPING) {
    test(id + ': the installed hook with ' + label + ' denies in the agent\'s format and the hook does not run', { skip: e2eSkip }, (t) => {
      const f = fixture(t);
      a.install(f);
      const r = runEntry(a.entry(f), f, extra);
      a.denied(r);
      assert.equal(fs.existsSync(f.ran), false, 'the hook ran');
    });
  }

  test(id + ': with no loader variable the installed hook reaches the hook, with no loader variable left', { skip: e2eSkip }, (t) => {
    const f = fixture(t);
    const rep = a.install(f);
    assert.ok(!rep.warnings.some((w) => /static hook launcher/.test(w)), rep.warnings.join('\n'));
    const entry = a.entry(f);
    assert.match(typeof entry === 'string' ? entry : entry.exec || entry.command, /\/zn-hook-launcher$|^\S+\/zn-hook-launcher /, 'the entry starts the static launcher');
    const r = runEntry(entry, f, { LD_LIBRARY_PATH: '/example/lib', ld_preload: '/example/x.so', LD_SHOW_AUXV: '1', NODE_OPTIONS: '--no-warnings' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(f.ran, 'utf8'), /^hook ran /);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.seen, 'utf8')), []);
  });
}

test('the launcher fails closed when the hook program cannot start', { skip: e2eSkip }, () => {
  const r = spawnSync(BIN, ['zcode', 'PreToolUse', '/example/no-such-hook'], { encoding: 'utf8', env: {} });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /its hook failed, so this was blocked/);
  const g = spawnSync(BIN, ['antigravity', 'PreToolUse', 'relative/hook'], { encoding: 'utf8', env: {} });
  assert.equal(g.status, 0);
  assert.equal(JSON.parse(g.stdout).decision, 'deny');
  const u = spawnSync(BIN, [], { encoding: 'utf8', env: {} });
  assert.equal(u.status, 2);
});

test('a launcher that does not match its recorded SHA-256 is not used: today\'s form stays and the install says so', { skip: KEY ? false : 'Linux only' }, (t) => {
  const f = fixture(t);
  f.nativeDir = nativeDirWith(f.home, Buffer.from('not the launcher'), 'a'.repeat(64));
  const rep = AGENTS.zcode.install(f);
  const entry = AGENTS.zcode.entry(f);
  assert.match(entry.command, /zn-hook-zcode\.sh$/);
  assert.ok(rep.warnings.some((w) => /static hook launcher/.test(w) && /does not match its recorded SHA-256/.test(w) && /LD_TRACE_LOADED_OBJECTS/.test(w)), rep.warnings.join('\n'));
  assert.equal(fs.existsSync(sl.staticFile({ home: f.home, env: {} })), false);
});

test('a copy of zn-gate without the launcher keeps today\'s form and says so, for each agent', { skip: KEY ? false : 'Linux only' }, (t) => {
  for (const [id, a] of Object.entries(AGENTS)) {
    if (!sl.STATIC_ENABLED.includes(id)) continue;
    const f = fixture(t);
    f.nativeDir = path.join(f.home, 'none');
    const rep = a.install(f);
    const entry = a.entry(f);
    const text = typeof entry === 'string' ? entry : entry.exec || [entry.command, ...(entry.args || [])].join(' ') || entry.bash;
    assert.doesNotMatch(String(text), /zn-hook-launcher/, id);
    assert.ok(rep.warnings.some((w) => /static hook launcher/.test(w)), id + ': ' + rep.warnings.join('\n'));
  }
});

test('macOS and Windows get no static launcher and no warning about it', () => {
  assert.equal(sl.platformKey('darwin', 'arm64'), null);
  assert.equal(sl.platformKey('win32', 'x64'), null);
  assert.equal(sl.installStatic({ platform: 'darwin' }), null);
  assert.equal(sl.platformKey('linux', 'ia32'), '');
  assert.match(sl.installStatic({ platform: 'linux', arch: 'ia32' }).warning, /no prebuilt launcher is built for ia32 Linux/);
});

test('launcher.js exports the four text functions and each returns a non-empty string', () => {
  for (const name of ['loaderText', 'loaderWarnText', 'crashText', 'crashWarnText']) {
    assert.equal(typeof launcher[name], 'function', name);
    const text = launcher[name]('zcode');
    assert.ok(typeof text === 'string' && text.length > 0, name);
  }
});

test('the launcher answers with the same texts as the sh launcher, and knows the same loader variables', () => {
  const src = fs.readFileSync(RUST, 'utf8');
  for (const text of [launcher.loaderText(), launcher.loaderWarnText(), launcher.crashText('zcode'), launcher.crashWarnText()]) {
    assert.ok(src.includes(JSON.stringify(text)), 'main.rs lacks: ' + text);
  }
  const list = (name) => {
    const m = new RegExp('const ' + name + ': &\\[&str\\] = &\\[([^\\]]*)\\];').exec(src);
    assert.ok(m, name);
    return [...m[1].matchAll(/"([A-Z0-9_]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(list('LOADER_PREFIXES'), loaderEnv.LOADER_PREFIXES);
  assert.deepEqual(list('LOADER_NAMES'), loaderEnv.LOADER_NAMES);
  assert.deepEqual(list('LOADER_PRELOAD'), loaderEnv.LOADER_PRELOAD);
  // The agents and blocking events the launcher answers for are the ones the adapters use.
  assert.deepEqual(sl.STATIC_AGENTS, ['claude-code', 'zcode', 'antigravity']);
  for (const id of ['claude-code', 'zcode', 'antigravity']) {
    for (const ev of launcher.blockExit(id)) assert.ok(src.includes('"' + ev + '"'), id + ' ' + ev);
  }
});

// Only a launch form that was run with the real agent gets the launcher. The rest keep today's hook form and say nothing about it.
test('ZCode and Claude Code get the static launcher on Linux: Antigravity stays detection only', { skip: KEY ? false : 'Linux only' }, (t) => {
  assert.deepEqual(sl.STATIC_ENABLED, ['zcode', 'claude-code']);
  for (const id of sl.STATIC_ENABLED) assert.ok(sl.STATIC_AGENTS.includes(id), id);
  for (const [id, a] of Object.entries(AGENTS)) {
    const f = fixture(t);
    const rep = a.install(f);
    const entry = a.entry(f);
    const text = typeof entry === 'string' ? entry : entry.exec || [entry.command, ...(entry.args || [])].join(' ') || entry.bash;
    if (sl.STATIC_ENABLED.includes(id)) {
      if (haveBin) assert.match(String(text), /zn-hook-launcher/, id);
      continue;
    }
    assert.doesNotMatch(String(text), /zn-hook-launcher/, id);
    assert.equal(Array.isArray(entry.args), false, id + ' has no exec form');
    assert.ok(!rep.warnings.some((w) => /static hook launcher/.test(w)), id + ': ' + rep.warnings.join('\n'));
    assert.equal(fs.existsSync(sl.staticFile({ home: f.home, env: {} })), false, id);
  }
});

test('Antigravity on Windows and macOS keeps its launcher script form', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.equal(sl.useStatic({ platform }, [], 'antigravity'), null, platform);
    assert.equal(sl.useStatic({ platform }, [], 'claude-code'), null, platform);
    assert.equal(sl.useStatic({ platform }, [], 'zcode'), null, platform);
  }
});

test('GitHub Copilot keeps today\'s hook form on Linux (detection only), with no launcher warning', (t) => {
  const f = fixture(t);
  const rep = require('../lib/agents/copilot').install({ ...opts(f), scope: 'user' });
  const entry = readJson(path.join(f.home, '.copilot', 'hooks', 'zn-gate.json')).hooks.preToolUse.at(-1);
  assert.equal(entry.exec, undefined);
  assert.equal(entry.args, undefined);
  assert.equal(typeof entry.bash, 'string');
  assert.doesNotMatch(entry.bash, /zn-hook-launcher/);
  assert.ok(!rep.warnings.some((w) => /static hook launcher/.test(w)), rep.warnings.join('\n'));
  assert.equal(fs.existsSync(sl.staticFile({ home: f.home, env: {} })), false);
  assert.throws(() => sl.execParts('/x/zn-hook-launcher', 'copilot', 'preToolUse', '/usr/bin/node'), /no static launcher for copilot/);
});

test('the exec-form entries are recognized as zn\'s and read back by check', (t) => {
  const hooks = path.join(tempDir(t, 'zn-exec-form-'), '.zn', 'hooks');
  const st = path.join(hooks, 'zn-hook-launcher');
  const cfg = require('../lib/agents/config-file');
  const zc = require('../lib/agents/zcode');
  const zText = zc.commandText({ type: 'process', command: st, args: ['zcode', 'PreToolUse', path.join(hooks, 'zn-hook-zcode.sh'), 'PreToolUse'] });
  assert.equal(zText, "'" + st + "' zcode PreToolUse '" + path.join(hooks, 'zn-hook-zcode.sh') + "' PreToolUse");
  assert.ok(cfg.isOurs(zText, 'zcode'));
  assert.ok(cfg.isOurs([st, 'antigravity', 'PreToolUse', path.join(hooks, 'zn-hook-antigravity.sh'), 'PreToolUse'].join(' '), 'antigravity'));
});

test('the package update refresh replaces an installed launcher that differs from the package copy', { skip: e2eSkip }, (t) => {
  const f = fixture(t);
  AGENTS.zcode.install(f);
  const file = sl.staticFile({ home: f.home, env: {} });
  fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('x')]), { mode: 0o755 });
  const done = require('../lib/agents/refresh').refreshLaunchers({ home: f.home, env: { HOME: f.home }, nativeDir: f.nativeDir, platform: 'linux' });
  assert.ok(done.includes(sl.NAME), JSON.stringify(done));
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(BIN)));
});
