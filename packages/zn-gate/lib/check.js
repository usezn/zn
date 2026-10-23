'use strict';

/**
 * zn-gate check: shows, safely, that the zn hooks installed for each agent
 * stop a secret from being read and still let ordinary files through.
 *
 * It makes a temporary folder with a .env file that holds an obviously fake
 * key and a README.txt, and for each agent:
 *   - finds zn's user-level setup: the hook for the agent's read event, with
 *     a matcher that covers the read, or, for Claude Code, the zn-gate plugin
 *     listed in installed_plugins.json and not turned off;
 *   - asks zn what it decides for a read of .env (must block) and of
 *     README.txt (must be allowed);
 *   - runs the installed hook the same way the agent does, with the same two
 *     requests, so a hook that cannot start, or that blocks everything because
 *     part of zn is missing, is reported instead of passing.
 * An installed command is run only when it has the exact shape zn writes,
 * with Node.js and a real zn-gate runner, as node + runner without a shell,
 * in the temporary folder. Nothing leaves the machine, no agent is started,
 * no setting changes, and the folder is deleted at the end. Project-level
 * setups are reported but not run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { nodeAdvice } = require('./node-support');

const FAKE_LINE = 'ZN_CHECK_EXAMPLE_KEY=zn-check-fake-value-not-a-real-key\n';
const HOOK_TIMEOUT_MS = 15000;
const PLUGIN_ID = 'zn-gate@usezn';

/* The zn-gate Claude Code plugin needs Node.js 20.19 or later; zn-gate itself runs on 18 and later.
   This is the one place that says which version; the messages below and in init are built from it. */
const PLUGIN_NODE_MIN = '20.19';
function pluginNodeOk(version) {
  const [major, minor] = String(version || process.versions.node).split('.').map((x) => parseInt(x, 10) || 0);
  // The plugin loads zn-gate through a loader constant that arrives in Node.js 20.12 and 21.7, and its locked
  // dependencies (@noble/*) declare Node.js 20.19 or later, so the floor on the 20 line is 20.19.
  return major > 21 || (major === 21 && minor >= 7) || (major === 20 && minor >= 19);
}
function pluginNodeMessage(version) {
  return 'the zn-gate plugin needs Node.js ' + PLUGIN_NODE_MIN + ' or later (you have ' + String(version || process.versions.node) + ')';
}

/* The plugin's hooks run `node` as Claude Code finds it on its PATH, which is not always the Node.js that runs
   zn-gate (npx, nvm, several installs). This finds that `node` and asks it for its version. Never throws:
   null means it could not be found or run. Same binary as this process: no need to start it. */
function resolveHookNode(env) {
  try {
    const exe = require('./exe');
    const isWin = process.platform === 'win32';
    const absPath = String((env || process.env).PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d)).join(path.delimiter);
    const found = exe.whichSync(isWin ? 'node.exe' : 'node', absPath);
    if (!found) return null;
    const file = path.resolve(found);
    const norm = (f) => { let r = path.resolve(f); try { r = fs.realpathSync(r); } catch (err) { /* keep it */ } return isWin ? r.toLowerCase() : r; };
    if (norm(file) === norm(process.execPath)) return { version: process.versions.node, path: file };
    const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true, shell: false });
    const m = /^v(\d+\.\d+\.\d+)/.exec(String(r.stdout || '').trim());
    return r.status === 0 && m ? { version: m[1], path: file } : null;
  } catch (err) {
    return null;
  }
}

/* What the plugin's hooks will run on: {ok, unknown, version, why}. opts: nodeVersion (this zn-gate's, injected in
   tests), hookNode (injected: a {version, path}, null for "unknown", or a function(env) returning one). Given only
   nodeVersion, the hooks are taken to run on that same Node.js. */
function pluginNodeStatus(opts = {}) {
  const zn = opts.nodeVersion || process.versions.node;
  let hook = opts.hookNode;
  if (typeof hook === 'function') hook = hook(opts.env || process.env);
  else if (hook === undefined) hook = opts.nodeVersion ? { version: opts.nodeVersion, path: null } : resolveHookNode(opts.env);
  if (!hook || !hook.version) {
    return { ok: false, unknown: true, version: null, zn, why: 'zn-gate could not find or run the `node` that Claude Code will start the hooks of the plugin with (the first one on your PATH)' };
  }
  const same = !hook.path || hook.version === zn;
  const why = same ? 'you have ' + hook.version
    : 'Claude Code will run the hooks of the plugin with Node.js ' + hook.version + (hook.path ? ' (from ' + hook.path + ')' : '') + '; zn-gate itself runs on Node.js ' + zn;
  return { ok: pluginNodeOk(hook.version), unknown: false, version: hook.version, zn, why };
}
function pluginNodeProblem(st) {
  return st.unknown ? 'the zn-gate plugin could not be checked: ' + st.why
    : 'the zn-gate plugin needs Node.js ' + PLUGIN_NODE_MIN + ' or later (' + st.why + ')';
}

const AGENTS = [
  {
    id: 'claude-code', name: 'Claude Code', event: 'PreToolUse', tool: 'Read',
    fix: 'install the zn-gate plugin: `claude plugin marketplace add usezn/zn`, then `claude plugin install zn-gate@usezn`',
    file: (a, o) => a.settingsFile(o), project: (dir) => path.join(dir, '.claude', 'settings.json'),
    request: (dir, file) => ({ hook_event_name: 'PreToolUse', session_id: 'zn-check', cwd: dir, tool_name: 'Read', tool_input: { file_path: file } }),
  },
  {
    id: 'codex', name: 'Codex CLI', event: 'PreToolUse', tool: 'Bash',
    fix: 'run `zn hooks install codex` in your own terminal',
    file: (a, o) => a.hooksFile(o), project: (dir) => path.join(dir, '.codex', 'hooks.json'),
    request: (dir, file) => ({ hook_event_name: 'PreToolUse', session_id: 'zn-check', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat ' + path.basename(file) } }),
  },
  {
    id: 'cursor', name: 'Cursor', event: 'beforeReadFile', tool: null,
    fix: 'run `zn hooks install cursor` in your own terminal',
    file: (a, o) => a.hooksFile(o), project: (dir) => path.join(dir, '.cursor', 'hooks.json'),
    request: (dir, file) => ({ hook_event_name: 'beforeReadFile', cwd: dir, file_path: file, content: 'x', workspace_roots: [dir] }),
  },
  {
    id: 'opencode', name: 'OpenCode', event: null, tool: null,
    fix: 'run `zn hooks install opencode` in your own terminal',
    file: (a, o) => a.pluginPath(o), project: (dir) => path.join(dir, '.opencode', 'plugins', 'zn-gate.js'),
    request: (dir, file) => ({ hook: 'tool.execute.before', tool: 'read', cwd: dir, args: { filePath: file } }),
  },
  {
    id: 'antigravity', name: 'Antigravity', event: 'PreToolUse', tool: 'view_file',
    fix: 'run `zn hooks install antigravity` in your own terminal',
    file: (a, o) => a.hooksFile(o), project: (dir) => path.join(dir, '.agents', 'hooks.json'),
    request: (dir, file) => ({ conversationId: 'zn-check', workspacePaths: [dir], toolCall: { name: 'view_file', args: { AbsolutePath: file } }, stepIdx: 0 }),
  },
  {
    id: 'copilot', name: 'Copilot CLI (experimental)', event: 'preToolUse', tool: 'view',
    fix: 'run `zn hooks install copilot` in your own terminal',
    file: (a, o) => a.hooksFile(o), project: (dir) => path.join(dir, '.github', 'hooks', 'zn-gate.json'),
    request: (dir, file) => ({ sessionId: 'zn-check', timestamp: 0, cwd: dir, toolName: 'view', toolArgs: { path: file } }),
  },
  {
    id: 'gemini', name: 'Gemini CLI', event: 'BeforeTool', tool: 'read_file',
    fix: 'run `zn hooks install gemini` in your own terminal',
    file: (a, o) => a.settingsFile(o), project: (dir) => path.join(dir, '.gemini', 'settings.json'),
    request: (dir, file) => ({ hook_event_name: 'BeforeTool', session_id: 'zn-check', cwd: dir, tool_name: 'read_file', tool_input: { file_path: file } }),
  },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return null;
  }
}

/* [{event, matcher, command}] from a hooks file: Claude Code and Codex use groups with a matcher, Cursor plain entries. */
function hookEntries(tree, agentId) {
  const out = [];
  // Claude Code, Codex and Cursor keep events under "hooks". Antigravity keeps named hooks at the top level
  // (and only there), each with its own "enabled" flag.
  const sets = [];
  if (agentId === 'antigravity') {
    for (const v of Object.values(tree && typeof tree === 'object' ? tree : {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && v.enabled !== false) sets.push(v);
    }
  } else {
    sets.push(tree && typeof tree.hooks === 'object' ? tree.hooks : {});
  }
  for (const hooks of sets) {
    for (const [event, list] of Object.entries(hooks || {})) {
      for (const g of Array.isArray(list) ? list : []) {
        if (!g || typeof g !== 'object') continue;
        if (typeof g.command === 'string') out.push({ event, matcher: g.matcher, command: g.command, onFailure: g.onFailure, async: g.async });
        // GitHub Copilot CLI keeps the shell command in "bash" (and "powershell"), next to an optional matcher.
        if (agentId === 'copilot' && typeof g.bash === 'string') out.push({ event, matcher: g.matcher, command: g.bash });
        for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
          if (h && typeof h.command === 'string') out.push({ event, matcher: g.matcher, command: h.command, onFailure: h.onFailure, async: h.async });
        }
      }
    }
  }
  return out;
}

function matcherCovers(matcher, tool) {
  if (!tool || matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp('^(?:' + matcher + ')$').test(tool);
  } catch (err) {
    return String(matcher).split('|').includes(tool);
  }
}

/* A zn hook command: {node, runner} (run directly), {onPath} (`zn hook <agent>`) or null. */
function parseCommand(command, agentId) {
  const { _internal: audit } = require('./audit');
  const c = require('./shell-quote').readableWindowsCommand(String(command).trim());
  // zn's launcher script (lib/agents/launcher.js): '<dir>/zn-hook-<agent>.sh' <Event>. It names the Node.js and
  // runner it was installed with in ZN_NODE=... and ZN_RUNNER=... lines.
  const lm = new RegExp("^'(" + audit.SAFE_ABS + '/zn-hook-' + agentId + "\\.sh)' ([A-Za-z]+)$").exec(c);
  if (lm) {
    let text = '';
    try { text = fs.readFileSync(lm[1], 'utf8'); } catch (err) { return { launcher: lm[1], event: lm[2], unreadable: true }; }
    const n = new RegExp("^ZN_NODE='(" + audit.SAFE_ABS + ")'$", 'm').exec(text);
    const r = new RegExp("^ZN_RUNNER='(" + audit.SAFE_ABS + ")'$", 'm').exec(text);
    if (!n || !r) return { launcher: lm[1], event: lm[2], unreadable: true };
    return { launcher: lm[1], event: lm[2], node: n[1], runner: r[1] };
  }
  // On Windows, Cursor and Gemini CLI run the same three steps as an encoded PowerShell script (launcher.windowsScript).
  const ws = require('./shell-quote').windowsCommandScript(c);
  if (ws) {
    // Both the current script and the one written by earlier versions (no progress line, unconditional exit).
    const wm = /^(?:\$ProgressPreference='SilentlyContinue'; \$zt=0; )?if \(\(Test-Path -LiteralPath '([^']+)'\) -and \(Test-Path -LiteralPath '([^']+)'\)\) \{ (?:\$zt=1; )?& '[^']+' '[^']+' ([a-z-]+); (?:if \(\$LASTEXITCODE -eq 0 -or \$LASTEXITCODE -eq 2\) \{ exit (?:\$LASTEXITCODE|0) \}|exit \$LASTEXITCODE) \}; .* # zn hook ([a-z-]+)$/s.exec(ws);
    // winScript is the PowerShell text itself: c may be its readable -Command form, which is not base64.
    if (wm && wm[3] === agentId && wm[4] === agentId) return { winScript: ws, node: wm[1], runner: wm[2] };
  }
  if (!c.endsWith(' ' + agentId) && !c.endsWith(' ' + agentId + '"')) return null;
  if (audit.OUR_HOOKS[0].test(c)) return { onPath: true };
  const quoted = new RegExp("^'(" + audit.SAFE_ABS + ")' '(" + audit.SAFE_ABS + "/zn-gate/lib/hooks/runner\\.js)' " + agentId + '$');
  for (const re of [audit.OUR_HOOKS[1], audit.OUR_HOOKS[2], quoted]) {
    const m = re.exec(c);
    if (!m) continue;
    let node = null;
    let runner = null;
    try {
      node = fs.realpathSync(m[1]);
      runner = fs.realpathSync(m[2]);
    } catch (err) {
      return { node: m[1], runner: m[2], missing: true };
    }
    if (!/^node(?:js)?(?:\.exe)?$/i.test(path.basename(node)) || !audit.znGateFile(runner, 'lib/hooks/runner.js')) return null;
    return { node, runner };
  }
  return null;
}

function decisionOf(stdout, status) {
  if (status === 2) return 'deny';
  const o = String(stdout || '');
  if (/"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"(?:deny|block)"|"permission"\s*:\s*"deny"|"continue"\s*:\s*false/.test(o)) return 'deny';
  return 'allow';
}

function spawnHook(file, args, input, env, cwd) {
  const r = spawnSync(file, args, {
    input: JSON.stringify(input), encoding: 'utf8', timeout: HOOK_TIMEOUT_MS, cwd,
    env: { ...process.env, ZN_STATS: 'off', ...env }, windowsHide: true,
  });
  if (r.error) return { ran: false, why: r.error.code || r.error.message };
  return { ran: true, decision: decisionOf(r.stdout, r.status), stdout: r.stdout, status: r.status };
}

/* Folders of the zn-gate Claude Code plugin listed in installed_plugins.json. */
function claudePlugin(home, env) {
  const cc = require('./agents').getAdapter('claude-code');
  const dir = cc.configDir({ home, env });
  const listed = readJson(path.join(dir, 'plugins', 'installed_plugins.json'));
  const entries = listed && listed.plugins && listed.plugins[PLUGIN_ID];
  const roots = (Array.isArray(entries) ? entries : entries ? [entries] : [])
    .map((e) => e && e.installPath).filter((p) => typeof p === 'string' && fs.existsSync(path.join(p, 'scripts', 'zn-launch.js')));
  const settings = readJson(cc.settingsFile({ home, env })) || {};
  const off = settings.enabledPlugins && settings.enabledPlugins[PLUGIN_ID] === false;
  return { root: roots[0] || null, off };
}

/* zn's hooks in the agent's managed configuration: {files, entries} | null. Never throws. */
function managedFor(agentId, ctx) {
  try {
    const opts = agentId === 'claude-code' ? ctx.claudePolicy : agentId === 'codex' ? ctx.codexPolicy : agentId === 'cursor' ? ctx.cursorPolicy : null;
    if (opts === null) return null;
    return require('./agents/managed-policy').managedInstall(agentId, { ...(opts || {}), env: ctx.env });
  } catch (_) {
    return null;
  }
}

/* Hook policy warnings for Claude Code (managed settings, disableAllHooks), as `zn-gate status` shows. */
function claudePolicy(home, env, opts) {
  try {
    const cc = require('./agents').getAdapter('claude-code');
    const w = require('./agents/managed-policy').claudeCodePolicyWarnings({ ...(opts || {}), userSettings: [cc.settingsFile({ home, env })], mcp: false });
    return w.filter((x) => /hooks/i.test(x));
  } catch (err) {
    return [];
  }
}

/* Codex hooks with `async` set (true, or the string "true" from TOML) run in the background: they cannot block or change anything. */
function isBackground(e) {
  return e.async === true || e.async === 'true';
}

/* The first file that sets one of zn's Codex hooks to run in the background: the Codex home's hooks.json and config.toml. */
function codexBackgroundFile(codexHome, hooksFile) {
  const trees = [[hooksFile, readJson(hooksFile)]];
  try {
    trees.push([path.join(codexHome, 'config.toml'), require('./audit/parse').parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).data]);
  } catch (_) { /* no config.toml, or one zn cannot read: nothing to say here */ }
  for (const [file, tree] of trees) {
    const hit = hookEntries(tree, 'codex').find((e) => isBackground(e) && parseCommand(e.command, 'codex'));
    if (hit) return { file, event: hit.event };
  }
  return null;
}

/* Codex keeps a per-hook switch in config.toml: [hooks.state."<hooks file>:<event>:<group>:<hook>"] enabled = false.
   The key is the file that declares the hook, the event in snake case, and the 0-based position of the group and of the hook in it. */
function samePath(a, b) {
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/* The first of zn's Codex hooks (in the files given) that the user's config.toml switches off with hooks.state; null if none. */
function codexHookSwitchedOff(codexHome, files) {
  let state;
  try {
    const data = require('./audit/parse').parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).data;
    state = data && data.hooks && data.hooks.state;
  } catch (_) { return null; /* no config.toml, or one zn cannot read: nothing to say here */ }
  if (!state || typeof state !== 'object') return null;
  const { isOurs } = require('./agents/config-file');
  for (const [key, st] of Object.entries(state)) {
    if (!st || typeof st !== 'object' || (st.enabled !== false && st.enabled !== 'false')) continue;
    const m = /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(key.trim());
    if (!m) continue;
    const src = files.find((f) => samePath(f, m[1]));
    if (!src) continue;
    const tree = src.endsWith('.toml') ? (() => { try { return require('./audit/parse').parseToml(fs.readFileSync(src, 'utf8')).data; } catch (_) { return null; } })() : readJson(src);
    const hooks = tree && typeof tree.hooks === 'object' && tree.hooks ? tree.hooks : {};
    const event = Object.keys(hooks).find((e) => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() === m[2]);
    const group = event && Array.isArray(hooks[event]) ? hooks[event][Number(m[3])] : null;
    const hook = group && Array.isArray(group.hooks) ? group.hooks[Number(m[4])] : null;
    if (hook && isOurs(hook.command, 'codex')) return { file: path.join(codexHome, 'config.toml'), event };
  }
  return null;
}

function oneLine(s, n) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

/* A sentence without its final full stop, to quote it inside another one. */
function bare(s) {
  return String(s || '').replace(/[\s.]+$/, '');
}

const RULES_FIX = 'install zn-gate again: run `npm install -g zn-gate` in your own terminal, then run `zn-gate check` again';
const REINSTALL = (id) => 'install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install ' + id + '`, in your own terminal';

/* Absolute path of `name`, searched only in absolute PATH entries; null when there is none. */
function onAbsPath(name, env) {
  const absPath = String((env || process.env).PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d)).join(path.delimiter);
  const found = require('./exe').whichSync(process.platform === 'win32' ? name + (name === 'zn' ? '.cmd' : '.exe') : name, absPath);
  return found ? path.resolve(found) : null;
}

/* Absolute path of the `zn` command, searched only in absolute PATH entries; null when there is none. */
function znOnPath(env) {
  // Only absolute PATH entries: a relative one (node_modules/.bin, .) depends on the folder check runs from.
  const absPath = String((env || process.env).PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d)).join(path.delimiter);
  const found = require('./exe').whichSync(process.platform === 'win32' ? 'zn.cmd' : 'zn', absPath);
  return found ? path.resolve(found) : null;
}

/*
 * zn's own hooks in the user's hooks file (`zn hooks install <agent>`), not run yet:
 * {installed, problem, fix, live, notes}. `live` is {file, args, env} when the read hook can be run as the agent runs it.
 */
function cliHooks(spec, ctx, userFile, given) {
  const out = { installed: false, problem: '', fix: '', live: null, notes: [] };
  // `given`: hook entries already read from the managed configuration instead of the user's hooks file.
  const entries = (given || hookEntries(readJson(userFile), spec.id)).filter((e) => parseCommand(e.command, spec.id));
  out.installed = entries.length > 0;
  if (!out.installed) return out;
  // Set up with `zn hooks install`, so that is also how to repair it (not the plugin: both would run).
  out.fix = 'run `zn hooks install ' + spec.id + '` in your own terminal';
  const read = entries.find((e) => e.event === spec.event && matcherCovers(e.matcher, spec.tool));
  if (!read) {
    out.problem = 'zn\'s hooks are there, but not the one that checks reading files (' + spec.event + ')';
    return out;
  }
  const cmd = parseCommand(read.command, spec.id);
  if (cmd.launcher || cmd.winScript) {
    // The launcher runs the Node.js it was installed with, else `zn` from the PATH, else it blocks (see launcher.js).
    const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch (err) { return false; } };
    const recorded = !cmd.unreadable && isFile(cmd.node) && isFile(cmd.runner);
    const viaPath = !recorded && !cmd.unreadable && Boolean(znOnPath(ctx.env) && onAbsPath('node', ctx.env));
    if (cmd.unreadable) {
      out.problem = 'its hook cannot start: its launcher script (' + cmd.launcher + ') is missing or was changed';
      out.fix = REINSTALL(spec.id);
    } else if (!recorded && !viaPath) {
      out.problem = 'its hook cannot start: its ' + (isFile(cmd.node) ? 'zn-gate files (' + cmd.runner + ')' : 'Node.js (' + cmd.node + ')') + ' is no longer there, so zn now blocks the tool calls and prompts instead of checking them';
      out.fix = REINSTALL(spec.id);
    } else {
      if (viaPath) out.notes.push('the Node.js zn was installed with is gone; the hook now runs `zn` from your PATH. Run `zn hooks install ' + spec.id + '` to set it up again');
      // Run it with the PATH check was given, which is what decides whether `zn` and `node` are found.
      // Windows cannot run a .sh file directly; Claude Code runs it with sh (Git Bash) there.
      const run = cmd.winScript ? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cmd.winScript, 'utf16le').toString('base64')] }
        : process.platform === 'win32' ? { file: 'sh', args: [cmd.launcher, cmd.event] } : { file: cmd.launcher, args: [cmd.event] };
      out.live = { ...run, env: ctx.env && ctx.env.PATH ? { PATH: ctx.env.PATH } : {} };
    }
  } else if (cmd.missing) {
    out.problem = 'its hook cannot start: ' + (fs.existsSync(cmd.node) ? 'its zn-gate files (' + cmd.runner + ')' : 'its Node.js (' + cmd.node + ')') + ' is no longer there';
    // Usually a Node.js version removed with nvm (or similar), which takes its global zn-gate with it.
    out.fix = REINSTALL(spec.id);
  } else if (cmd.onPath) {
    const zn = znOnPath(ctx.env);
    if (!zn) { out.problem = 'its hook runs `zn`, and there is no `zn` on your PATH'; out.fix = REINSTALL(spec.id); }
    else if (process.platform !== 'win32') out.live = { file: zn, args: ['hook', spec.id], env: {} };
    else out.notes.push('the installed hook runs `zn` from your PATH; zn\'s rules were checked directly');
  } else {
    out.live = { file: cmd.node, args: [cmd.runner, spec.id], env: {} };
  }
  return out;
}

/* Runs an installed hook with the two requests: '' when it blocks .env and allows the ordinary file, else the problem. */
function runLive(spec, ctx, live) {
  const a = spawnHook(live.file, live.args, spec.request(ctx.dir, ctx.envFile), live.env, ctx.dir);
  const b = a.ran ? spawnHook(live.file, live.args, spec.request(ctx.dir, ctx.readme), live.env, ctx.dir) : a;
  if (!a.ran) return 'its hook cannot start (' + a.why + ')';
  if (a.decision !== 'deny') return 'the installed hook did not block the read of .env';
  if (b.decision === 'deny') return 'the installed hook blocks everything, ordinary files too, so part of zn is missing or broken';
  return '';
}

/* Whether a documented Copilot CLI setting turns zn's hooks off: {problem, fix, notes}. */
function copilotSwitchedOff(userFile, ctx, adapter) {
  const out = { problem: '', fix: '', notes: [] };
  const mine = readJson(userFile);
  if (mine && mine.disableAllHooks === true) {
    out.problem = 'zn\'s hooks file has "disableAllHooks" turned on, so Copilot skips it';
    out.fix = 'run `zn hooks install copilot` in your own terminal (it turns the hooks back on)';
    return out;
  }
  for (const name of ['settings.json', 'settings.local.json']) {
    const f = path.join(ctx.cwd, '.github', 'copilot', name);
    const s = require('./audit')._internal.readBounded(f, 256 * 1024, false).text;
    let j = null;
    try { j = s ? JSON.parse(s.replace(/^\uFEFF/, '')) : null; } catch (_) { j = null; }
    if (j && j.disableAllHooks === true) {
      out.problem = 'the Copilot settings of this folder (' + f + ') have "disableAllHooks" turned on, so Copilot runs no hook of yours here (only machine policy hooks)';
      out.fix = 'remove "disableAllHooks" from that file, then run `zn-gate check` again';
      return out;
    }
  }
  const user = readJson(path.join(adapter.copilotHome({ home: ctx.home, env: ctx.env }), 'settings.json'));
  if (user && user.disableAllHooks === true) out.notes.push('your Copilot user settings have "disableAllHooks" turned on; the docs do not say whether that skips hook files, so check that zn still runs');
  out.notes.push('Copilot also loads machine policy hooks (/etc/github-copilot/policy.d) and skips a hook that takes longer than its timeout; zn cannot see either from here');
  return out;
}

async function checkAgent(spec, ctx) {
  const { getAdapter } = require('./agents');
  const runner = require('./hooks/runner');
  const adapter = getAdapter(spec.id);
  const res = { id: spec.id, name: spec.name, fix: spec.fix, state: 'not-set-up', problem: '', message: '', notes: [] };
  const userFile = spec.file(adapter, { home: ctx.home, env: ctx.env });

  // zn's own decision for the two requests (no hook involved). Without live checks only the setup is read.
  let rulesOk = true;
  if (ctx.live) {
    const secret = await runner.handle(adapter, spec.request(ctx.dir, ctx.envFile), { home: ctx.home });
    const control = await runner.handle(adapter, spec.request(ctx.dir, ctx.readme), { home: ctx.home });
    res.message = oneLine(secret.decision && secret.decision.message, 300);
    rulesOk = secret.decision && secret.decision.decision === 'deny' && !(control.decision && control.decision.decision === 'deny');
  }

  // What is installed for this user.
  let live = null;      // {file, args, env} to run, or {why} when it cannot start
  let installed = false;
  if (spec.id === 'claude-code') {
    const plugin = claudePlugin(ctx.home, ctx.env);
    const hasCliHooks = hookEntries(readJson(userFile), spec.id).some((e) => parseCommand(e.command, spec.id));
    // A plugin that is turned off runs nothing: with zn's own hooks next to it, those hooks are what protects
    // the agent, so they are checked as such (below) and never offered for removal.
    if (plugin.root && plugin.off && hasCliHooks) res.notes.push('the zn-gate plugin is also installed, but turned off');
    if (plugin.root && !(plugin.off && hasCliHooks)) {
      installed = true;
      res.where = 'the zn-gate plugin';
      res.via = 'plugin';
      // zn's own hooks left next to the plugin both run, and a broken prompt hook among them blocks every prompt.
      // Which set to drop depends on whether the plugin works, so the plugin is checked first (below).
      if (hasCliHooks) res.via = 'both';
      if (plugin.off) {
        res.pluginOff = true;
        res.problem = 'the zn-gate plugin is turned off in your Claude Code settings';
        res.fix = 'turn it on: run `claude plugin enable zn-gate@usezn` in your own terminal';
      }
      const nodeSt = plugin.off ? null : (ctx.pluginNode || (ctx.pluginNode = pluginNodeStatus(ctx)));
      if (nodeSt && !nodeSt.ok) {
        res.problem = pluginNodeProblem(nodeSt);
        res.fix = (nodeSt.unknown ? 'make sure `node --version` works in a new terminal and shows ' + PLUGIN_NODE_MIN + ' or later' : 'update Node.js to ' + PLUGIN_NODE_MIN + ' or later (the current LTS from nodejs.org), and make it the first `node` on your PATH') + ', or use zn\'s hooks instead: run `npm install -g zn-gate`, then `zn hooks install claude-code`, and after that turn the plugin off with `claude plugin disable zn-gate@usezn`, all in your own terminal';
        res.pluginFault = true;
        res.pluginNode = true;
      }
      const pre = ctx.live ? spawnHook(process.execPath, [path.join(plugin.root, 'scripts', 'zn-launch.js'), 'check', 'claude-code'], {}, { CLAUDE_PLUGIN_ROOT: plugin.root }, ctx.dir) : { ran: false };
      const sys = pre.ran && /"systemMessage"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(pre.stdout || '');
      // The launcher's own check message is about the plugin itself (for example a Node.js it does not support).
      if (!res.problem && sys) { res.problem = bare(oneLine(JSON.parse('"' + sys[1] + '"'), 300)); res.pluginFault = true; }
      live = { file: process.execPath, args: [path.join(plugin.root, 'scripts', 'zn-launch.js'), 'hook', 'claude-code'], env: { CLAUDE_PLUGIN_ROOT: plugin.root }, plugin: true };
    }
  }
  if (!installed && spec.id === 'opencode') {
    let src = '';
    try { src = fs.readFileSync(userFile, 'utf8'); } catch (err) { src = ''; }
    installed = /\/zn-gate\/lib\/hooks\/runner\.js"|"hook", "opencode"/.test(src);
    res.where = userFile;
  } else if (!installed) {
    const h = cliHooks(spec, ctx, userFile);
    installed = h.installed;
    res.where = userFile;
    if (installed) { res.fix = h.fix; res.via = 'hooks'; res.problem = h.problem; live = h.live; res.notes.push(...h.notes); }
  }
  // zn installed by the organization (managed settings, enterprise hooks.json, requirements.toml). Read-only.
  const managed = managedFor(spec.id, ctx);
  if (managed) {
    res.managed = managed.files[0];
    const mgWhere = managed.files.join(', ');
    if (!installed) {
      const h = cliHooks(spec, ctx, null, managed.entries);
      installed = true;
      res.where = managed.files[0];
      res.via = 'managed';
      res.problem = h.problem;
      live = h.live;
      res.notes.push(...h.notes);
      // Only an administrator can repair the managed files.
      res.fix = 'ask your administrator to repair the managed configuration (' + mgWhere + ')';
    } else {
      res.notes.push('zn is also set up in ' + res.where + ', next to the managed configuration, so its hooks run twice; to keep only the managed one, ' + (res.via === 'plugin' || res.via === 'both' ? 'turn the plugin off: `claude plugin disable zn-gate@usezn`' : 'run `zn hooks uninstall ' + spec.id + '`') + ' in your own terminal');
    }
    res.notes.unshift('zn is installed through your organization\'s managed configuration (' + mgWhere + ')');
  }
  if (spec.id === 'claude-code' && installed && res.where === userFile) {
    // Without onFailure "block", a prompt hook that cannot run lets every prompt through (Claude Code 2.1.295 and later read it).
    const prompt = hookEntries(readJson(userFile), spec.id).find((e) => e.event === 'UserPromptSubmit' && parseCommand(e.command, spec.id));
    if (prompt && prompt.onFailure !== 'block') res.notes.push('its prompt hook lets prompts through when it cannot run; run `zn hooks install claude-code` again to have them blocked instead');
    // Hooks written by an older zn-gate have no hook for typed skills and commands. The Claude Code version is not
    // known here, so the note is harmless on a version without that event.
    const hasExpansion = hookEntries(readJson(userFile), spec.id).some((e) => e.event === 'UserPromptExpansion' && parseCommand(e.command, spec.id));
    if (!hasExpansion) res.notes.push('its hooks lack the newer prompt-expansion check (for typed skills and commands); run `zn hooks install claude-code` again to add it');
  }
  if (spec.id === 'claude-code' && installed && (!res.problem || res.pluginFault)) {
    const p = claudePolicy(ctx.home, ctx.env, ctx.claudePolicy);
    // A Claude Code setting stops every hook, the plugin's and zn's own alike: that setting is the fix, not either set.
    if (p.length) {
      res.problem = bare(oneLine(p[0], 300));
      res.fix = 'change that Claude Code setting as it says, then run `zn-gate check` again';
      res.pluginFault = false;
    }
  }
  if (spec.id === 'codex' && installed && !res.problem) {
    // Codex requirements, its managed configuration or the user's config.toml can turn every hook off.
    let p = [];
    // The user's hooks.json sits in the Codex home folder, next to its config.toml.
    const codexHome = path.dirname(adapter.hooksFile({ home: ctx.home, env: ctx.env }));
    try { p = require('./agents/managed-policy').codexPolicyWarnings({ ...(ctx.codexPolicy || {}), env: ctx.env, codexHome }); } catch (_) { p = []; }
    // A file zn could not read is a note: zn does not know that it turns the hooks off.
    for (const w of p.filter((x) => /^could not read/.test(x))) res.notes.push(oneLine(w, 300));
    p = p.filter((x) => !/^could not read/.test(x));
    if (p.length) {
      res.problem = bare(oneLine(p[0], 300));
      res.fix = 'change that Codex setting as it says, then run `zn-gate check` again';
    }
  }
  if (spec.id === 'codex' && installed && !res.problem && res.where === userFile) {
    // A hook Codex runs in the background cannot block a call or change a result, so it protects nothing.
    const bg = codexBackgroundFile(path.dirname(userFile), userFile);
    if (bg) {
      res.problem = 'zn\'s ' + bg.event + ' hook runs in the background (async) in ' + bg.file + ', and a background hook cannot block anything, so zn does not protect Codex';
      res.fix = 'remove `async` from zn\'s hooks in that file, or run `zn hooks install codex` again, then run `zn-gate check` again';
    }
  }
  if (spec.id === 'codex' && installed && !res.problem && res.where === userFile) {
    // [hooks.state] in the user's config.toml can switch one hook off: Codex then skips it without a word.
    const off = codexHookSwitchedOff(path.dirname(userFile), [userFile, path.join(path.dirname(userFile), 'config.toml')]);
    if (off) {
      res.problem = 'zn\'s ' + off.event + ' hook is switched off in ' + off.file + ' ([hooks.state] enabled = false), so Codex skips it and zn does not protect Codex';
      res.fix = 'delete that [hooks.state] entry, or turn zn\'s hook back on in `/hooks` in Codex, then run `zn-gate check` again';
    }
  }
  if (spec.id === 'cursor' && installed) {
    // Cursor's enterprise hooks.json (read-only): zn's hook there without failClosed, or enterprise hooks without zn's.
    try { res.notes.push(...require('./agents/managed-policy').cursorPolicyWarnings({ ...(ctx.cursorPolicy || {}), env: ctx.env }).map((w) => oneLine(w, 400))); } catch (_) { /* never fails the check */ }
  }
  if (spec.id === 'gemini' && installed && !res.problem) {
    // hooksConfig.enabled false, or zn's hook named in hooksConfig.disabled, in the user, project or system settings.
    let p = [];
    try {
      p = require('./agents/managed-policy').geminiPolicyWarnings({
        files: [
          { file: userFile, label: 'your Gemini CLI settings' },
          { file: spec.project(ctx.cwd), label: 'this folder\'s Gemini CLI settings' },
          { file: ctx.geminiSystemFile || adapter.systemSettingsFile(), label: 'the system Gemini CLI settings' },
        ],
      });
    } catch (_) { p = []; }
    for (const w of p.filter((x) => /^could not read/.test(x))) res.notes.push(oneLine(w, 300));
    p = p.filter((x) => !/^could not read/.test(x));
    if (p.length) {
      res.problem = bare(oneLine(p[0], 300));
      res.fix = 'change that Gemini CLI setting as it says, then run `zn-gate check` again';
    }
  }
  if (spec.id === 'codex' && installed && !res.problem) {
    // Codex runs every PreToolUse hook at the same time, each with the original call: another tool's hook can
    // change a call after zn checked it, or answer an approval prompt. zn cannot see what that hook does.
    let other = null;
    try { other = require('./codex-other-hooks').findOtherHooks(path.dirname(userFile), ctx.cwd); } catch (_) { other = null; }
    if (other) {
      res.problem = 'another hook runs before Codex calls (' + other.event + ' in ' + other.file + '); it can change a call after zn has checked it, so zn cannot fully protect Codex';
      res.fix = 'review that hook and remove it if you do not need it, or have your administrator manage hooks with `allow_managed_hooks_only`, then run `zn-gate check` again';
    }
  }
  if (spec.id === 'copilot' && installed && !res.problem) {
    // Copilot skips a hooks file with "disableAllHooks": true, and every non-policy hook when a repository's settings say so.
    const off = copilotSwitchedOff(userFile, ctx, adapter);
    if (off.problem) { res.problem = off.problem; res.fix = off.fix; }
    res.notes.push(...off.notes);
  }
  if (spec.id === 'opencode' && installed) res.notes.push('zn\'s rules were checked; its plugin runs inside OpenCode, so it was not started here');

  if (!installed) {
    // Whether the agent is on this machine at all, so the report offers no setup for an agent that is not there.
    try { res.found = Boolean(adapter.detect({ home: ctx.home, env: ctx.env })); } catch (err) { res.found = true; }
    // `zn hooks install` needs zn-gate installed for the user: run from npx alone, there is no `zn` command yet.
    if (spec.id !== 'claude-code' && !znOnPath(ctx.env)) res.fix = 'run `npm install -g zn-gate`, then `zn hooks install ' + spec.id + '`, in your own terminal';
    const proj = spec.project(ctx.cwd);
    // The project folder can be anyone's repository: read only a regular file, and only so much of it.
    const text = path.resolve(proj) !== path.resolve(userFile) ? require('./audit')._internal.readBounded(proj, 256 * 1024, false).text : null;
    if (text && /zn|runner\.js/.test(text)) {
      res.state = 'project-only';
      res.where = proj;
    }
    return res;
  }
  if (!res.problem && !rulesOk) {
    // These are the rules of the copy that runs this command (with npx, its cached copy), not necessarily the
    // installed one; reinstalling zn-gate globally is still the repair that fits most cases.
    // zn's own rules, the ones this command runs, let the read through: the zn-gate install is what needs repair,
    // whatever runs the hooks (installing the plugin again or reinstalling the hooks would not change it).
    res.problem = 'zn did not block the read of .env';
    res.fix = RULES_FIX;
    res.rulesFault = true;
  }
  if (!res.problem && live && ctx.live) {
    res.problem = runLive(spec, ctx, live);
    if (res.problem && live.plugin) res.pluginFault = true;
    else if (!res.problem) res.verified = true;
  }
  if (res.via === 'both') {
    if (res.pluginFault) {
      // The plugin does not work here. Which way out keeps the agent protected depends on zn's own hooks next to
      // it, so they are checked now, also run as Claude Code runs them, before anything is said about them.
      res.pluginBroken = true;
      if (!rulesOk) {
        // zn's own rules let the read through, so neither set can work until zn-gate is repaired.
        res.problem = 'zn did not block the read of .env';
        res.fix = RULES_FIX;
        res.rulesFault = true;
        res.state = 'not-protected';
        return res;
      }
      const why = bare(res.problem);
      const h = cliHooks(spec, ctx, userFile);
      let hooksProblem = h.problem;
      if (!hooksProblem && !rulesOk) hooksProblem = 'zn did not block the read of .env';
      if (!hooksProblem && h.live) hooksProblem = runLive(spec, ctx, h.live);
      res.hooksBroken = Boolean(hooksProblem);
      if (!res.hooksBroken) {
        res.problem = 'the zn-gate plugin does not work here (' + why + '), while the hooks of `zn hooks install claude-code` next to it do';
        res.fix = 'turn the plugin off, which keeps those hooks: run `claude plugin disable zn-gate@usezn` in your own terminal, then run `zn-gate check` again';
      } else {
        // Repair the hooks first, and only then turn the plugin off: at no point does the agent have less than before.
        res.problem = 'the zn-gate plugin does not work here (' + why + '), and the hooks of `zn hooks install claude-code` next to it do not work either (' + bare(hooksProblem) + ')';
        res.fix = 'first repair the hooks: run `npm install -g zn-gate`, then `zn hooks install claude-code`; after that, turn the plugin off with `claude plugin disable zn-gate@usezn`; all in your own terminal, then run `zn-gate check` again';
      }
    } else if (!res.problem) {
      res.duplicate = true;
      res.verified = false;
      res.problem = 'the zn-gate plugin and the hooks of `zn hooks install claude-code` are both set up, so both run, and a broken one can block every prompt';
      res.fix = 'remove the second set: run `zn hooks uninstall claude-code` in your own terminal';
    }
  }
  res.state = res.problem ? 'not-protected' : 'protected';
  return res;
}

/* Warnings about the Node.js that runs zn-gate and the one the plugin's hooks will run on (end-of-life, or below the
   patched release of its line). They never change what is protected or the exit code. */
function nodeWarnings(opts, env) {
  const out = [];
  try {
    const zn = opts.nodeVersion || process.versions.node;
    const a = nodeAdvice(zn);
    if (a) out.push(a.message);
    let hook = opts.hookNode;
    if (typeof hook === 'function') hook = hook(env);
    else if (hook === undefined) hook = opts.nodeVersion ? null : resolveHookNode(env);
    if (hook && hook.version && hook.version !== zn) {
      const h = nodeAdvice(hook.version);
      if (h) out.push('The hooks will run on Node.js ' + hook.version + (hook.path ? ' (from ' + hook.path + ')' : '') + '. ' + h.message);
    }
  } catch (err) { /* a warning never fails the check */ }
  return out;
}

/**
 * check({home, env, cwd, live}) -> {results, removed, warnings}. Never throws for one agent.
 * With live: false only the setup is read: no test folder, no rules run, no hook started
 * (each result then has checked: false, and "protected" means set up with no problem found).
 */
async function check(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  if (opts.live === false) {
    const ctx = { home, env, cwd, live: false, dir: cwd, codexPolicy: opts.codexPolicy, claudePolicy: opts.claudePolicy, cursorPolicy: opts.cursorPolicy, geminiSystemFile: opts.geminiSystemFile, nodeVersion: opts.nodeVersion, hookNode: opts.hookNode, pluginNode: opts.pluginNode };
    const results = [];
    for (const spec of AGENTS) {
      try {
        results.push({ ...(await checkAgent(spec, ctx)), checked: false });
      } catch (err) {
        results.push({ id: spec.id, name: spec.name, fix: spec.fix, state: 'not-protected', problem: 'zn could not read its setup: ' + oneLine(err && err.message, 200), notes: [], checked: false });
      }
    }
    return { results, removed: true, warnings: nodeWarnings(opts, env) };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-check-'));
  const ctx = { home, env, cwd, live: true, dir, envFile: path.join(dir, '.env'), readme: path.join(dir, 'README.txt'), codexPolicy: opts.codexPolicy, claudePolicy: opts.claudePolicy, cursorPolicy: opts.cursorPolicy, geminiSystemFile: opts.geminiSystemFile, nodeVersion: opts.nodeVersion, hookNode: opts.hookNode, pluginNode: opts.pluginNode };
  const results = [];
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    fs.writeFileSync(ctx.envFile, FAKE_LINE, { mode: 0o600 });
    fs.writeFileSync(ctx.readme, 'An ordinary file that zn lets your agent read.\n');
    for (const spec of AGENTS) {
      try {
        results.push(await checkAgent(spec, ctx));
      } catch (err) {
        results.push({ id: spec.id, name: spec.name, fix: spec.fix, state: 'not-protected', problem: 'zn could not check it: ' + oneLine(err && err.message, 200), notes: [] });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { results, removed: !fs.existsSync(dir), warnings: nodeWarnings(opts, env) };
}

/** Plain-language report; returns the exit code (0 when every agent set up is protected). */
function report({ results, removed, warnings }, write) {
  const w = write || ((s) => process.stdout.write(s));
  w('\nzn-gate check: does zn stop your coding agent from reading a secret?\n\n');
  w('zn made a test folder with a fake key in a .env file and an ordinary file next to it, then asked\n');
  w('each agent\'s zn hook whether the agent may read them. This is what happened:\n\n');
  let setUp = 0;
  let bad = 0;
  const missing = [];
  for (const r of results) {
    if (r.state === 'not-set-up' && r.found === false) {
      w(`  -  ${r.name.padEnd(12)} not found on this machine\n`);
      continue;
    }
    if (r.state === 'not-set-up') {
      missing.push(r.name);
      w(`  -  ${r.name.padEnd(12)} zn is not set up for this agent. To protect it, ${r.fix}.\n`);
      continue;
    }
    if (r.state === 'project-only') {
      w(`  -  ${r.name.padEnd(12)} zn is set up only for one project (${r.where}). This check covers the setup for your user; to protect every project, ${r.fix}.\n`);
      continue;
    }
    setUp++;
    if (r.state === 'not-protected') {
      bad++;
      w(`  X  ${r.name.padEnd(12)} NOT protected: ${r.problem}.\n`);
      w(`     To fix it, ${r.fix}.\n`);
      continue;
    }
    w(`  OK ${r.name.padEnd(12)} blocked the .env file and allowed the ordinary file. Your agent would be told:\n`);
    w(`     "${r.message}"\n`);
    for (const n of r.notes) w(`     (${n})\n`);
  }
  w('\n');
  const init = 'run `npx -y zn-gate init` in your own terminal: it shows each step and asks before it runs one.\n';
  // Nothing to set up only when every agent is missing from the machine (a project-only setup counts as found).
  if (!setUp && !results.some((r) => r.found !== false || r.state !== 'not-set-up')) {
    w('No supported coding agent was found on this machine (Claude Code, Codex CLI, Cursor, OpenCode), so there is nothing to check.\n');
    w('Install one, then run `npx -y zn-gate init`. Other editors: https://usezn.com/docs/install\n\n');
  } else if (!setUp) {
    w('zn is not set up for your agents yet, so nothing protects your secrets. To set it up, ' + init);
    w('More: https://usezn.com/docs/install\n\n');
  } else if (!bad) {
    w('Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.\n');
    if (missing.length) w('Not set up yet: ' + missing.join(', ') + '. To add ' + (missing.length > 1 ? 'them' : 'it') + ', ' + init);
    w('If your agent needs a value from .env, keep it in zn\'s vault instead: `zn env shadow .env`.\n');
    w('More: https://usezn.com/docs/check\n\n');
  } else {
    w('Some agents are not protected (see above). More: https://usezn.com/docs/check\n\n');
  }
  for (const n of warnings || []) w('Warning: ' + n + '\n');
  if (warnings && warnings.length) w('\n');
  w(removed ? 'The test folder was deleted.\n' : 'The test folder could not be deleted; it holds only the fake key.\n');
  return setUp && !bad ? 0 : 1;
}

module.exports = { check, report, FAKE_LINE, AGENTS, _internal: { PLUGIN_NODE_MIN, pluginNodeOk, pluginNodeMessage, pluginNodeStatus, pluginNodeProblem, resolveHookNode, hookEntries, matcherCovers, parseCommand, decisionOf, claudePlugin } };
