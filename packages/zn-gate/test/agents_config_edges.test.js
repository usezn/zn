'use strict';
/*
 * Edge cases of the agent config code: a missing or broken config file, hooks
 * that zn does not own (they must survive install and uninstall), Windows
 * paths (the platform is injected, no global is changed), uninstall when
 * nothing is installed, and the managed policy present or absent.
 * Every path is inside a temporary fake home; no real user config is read.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const cfg = require('../lib/agents/config-file');
const claude = require('../lib/agents/claude-code');
const cursor = require('../lib/agents/cursor');
const opencode = require('../lib/agents/opencode');
const { claudeCodePolicyWarnings, managedDir } = require('../lib/agents/managed-policy');

const CMD = ['/usr/bin/node', '/opt/zn-gate/bin/cli.js', 'secrets-mcp', '--agent', 'claude-code'];
const ZN_SERVER = { command: '/usr/bin/node', args: ['/opt/zn-gate/bin/cli.js', 'secrets-mcp', '--agent', 'claude-code'] };

function fakeHome(t) {
  return tempDir(t, 'zn-agents-home-');
}

// env {} keeps CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME of the host out; the
// managed directory points at a path that does not exist, so the host's real
// /etc or Program Files policy is never read.
function opts(home, extra = {}) {
  return { home, env: {}, mcp: false, managedDir: path.join(home, 'no-managed-policy'), ...extra };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const text = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(text(file));

/* ------------------------------ config-file ------------------------------ */

test('config-file: a missing or blank file reads as an empty object', (t) => {
  const h = fakeHome(t);
  assert.deepEqual(cfg.readJson(path.join(h, 'missing.json')), {});
  const blank = path.join(h, 'blank.json');
  write(blank, '  \n');
  assert.deepEqual(cfg.readJson(blank), {});
});

test('config-file: broken JSON throws and the file is left unchanged', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, 'broken.json');
  write(file, '{ "hooks": ');
  assert.throws(() => cfg.readJson(file), /cannot parse .*\(left unchanged\)/);
  assert.equal(text(file), '{ "hooks": ');
});

test('config-file: a file that is not a JSON object is refused', (t) => {
  const h = fakeHome(t);
  const arr = path.join(h, 'array.json');
  const nul = path.join(h, 'null.json');
  write(arr, '[1, 2]');
  write(nul, 'null');
  assert.throws(() => cfg.readJson(arr), /must hold a JSON object, not an array/);
  assert.throws(() => cfg.readJson(nul), /must hold a JSON object, not null/);
});

test('config-file: a path that is a directory is a read error, not a missing file', (t) => {
  const h = fakeHome(t);
  const dir = path.join(h, 'a-dir.json');
  fs.mkdirSync(dir);
  assert.throws(() => cfg.readJson(dir), (err) => err.code === 'EISDIR');
});

test('config-file: hooksOf accepts missing or null and refuses other shapes', () => {
  assert.deepEqual(cfg.hooksOf({}, 'f'), {});
  assert.deepEqual(cfg.hooksOf({ hooks: null }, 'f'), {});
  assert.deepEqual(cfg.hooksOf({ hooks: { a: [] } }, 'f'), { a: [] });
  assert.throws(() => cfg.hooksOf({ hooks: [] }, 'f'), /must be an object, not an array/);
  assert.throws(() => cfg.hooksOf({ hooks: 'x' }, 'f'), /must be an object, not string/);
});

test('config-file: backup of a missing file is null; of an existing file is a copy', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, 'settings.json');
  assert.equal(cfg.backup(file), null);
  write(file, '{"keep":true}');
  const dest = cfg.backup(file);
  assert.match(path.basename(dest), /^settings\.json\.bak-zn-\d{8}T\d{6}$/);
  assert.equal(text(dest), '{"keep":true}');
});

test('config-file: writeJson creates the folder and ends the file with a newline', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, 'new', 'deep', 'config.json');
  cfg.writeJson(file, { a: 1 });
  assert.equal(text(file), '{\n  "a": 1\n}\n');
});

test('config-file: a project hook names zn on PATH; a user hook names this node and runner', () => {
  assert.equal(cfg.hookCommand('cursor', { scope: 'project' }), 'zn hook cursor');
  assert.equal(cfg.hookCommandWindows('cursor', { scope: 'project' }), 'zn hook cursor');
  assert.equal(cfg.hookCommand('cursor', { command: 'custom' }), 'custom');
});

test('config-file: Windows paths become forward-slash sh words when the platform is win32', () => {
  const o = { nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: 'C:\\zn\\lib\\hooks\\runner.js', platform: 'win32' };
  assert.equal(cfg.quoteArg('C:\\Program Files\\nodejs\\node.exe', 'win32'), "'C:/Program Files/nodejs/node.exe'");
  assert.equal(cfg.hookCommand('cursor', o), "'C:/Program Files/nodejs/node.exe' 'C:/zn/lib/hooks/runner.js' cursor");
});

test('config-file: isOurs recognises zn commands in every form and rejects other agents', () => {
  const o = { nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: 'C:\\zn\\lib\\hooks\\runner.js' };
  assert.equal(cfg.isOurs('zn hook cursor', 'cursor'), true);
  assert.equal(cfg.isOurs('zn hook codex', 'cursor'), false);
  assert.equal(cfg.isOurs("'/usr/bin/node' '/opt/zn/lib/hooks/runner.js' cursor", 'cursor'), true);
  assert.equal(cfg.isOurs('"/usr/bin/node" "/opt/zn/lib/hooks/runner.js" cursor', 'cursor'), true);
  assert.equal(cfg.isOurs(cfg.hookCommandWindows('cursor', o), 'cursor'), true);
  assert.equal(cfg.isOurs(cfg.hookCommandWindows('cursor', o), 'codex'), false);
  assert.equal(cfg.isOurs(42, 'cursor'), false);
});

/* -------------------------------- claude-code -------------------------------- */

test('claude-code: a fresh home gets the hooks; uninstall removes them and the hooks key', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.claude', 'settings.json');
  const r = claude.install(opts(h));
  assert.equal(r.settings, file);
  assert.equal(r.backup, null, 'nothing to back up in a fresh home');
  assert.deepEqual(Object.keys(json(file).hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptExpansion', 'UserPromptSubmit']);
  const u = claude.uninstall(opts(h));
  assert.equal(u.removed, 1);
  assert.equal(u.backup !== null, true);
  assert.equal('hooks' in json(file), false);
});

test('claude-code: install keeps the user\'s other hooks and drops only the old zn entry', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.claude', 'settings.json');
  write(file, JSON.stringify({
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /old/hooks/runner.js claude-code' }] }],
    },
  }));
  const r = claude.install(opts(h));
  assert.notEqual(r.backup, null);
  assert.equal(text(r.backup).includes('echo mine'), true, 'the backup keeps the original file');
  const after = json(file);
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.hooks.Notification, [{ hooks: [{ type: 'command', command: 'say done' }] }]);
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(after.hooks.PreToolUse[1].matcher, claude.PRE_MATCHER);
  assert.equal(after.hooks.PostToolUse.length, 1, 'the old zn group is replaced, not kept');
  assert.equal(after.hooks.PostToolUse[0].matcher, claude.POST_MATCHER);

  const u = claude.uninstall(opts(h));
  assert.equal(u.removed, 1);
  const left = json(file);
  assert.equal(left.model, 'opus');
  assert.deepEqual(left.hooks.PreToolUse, [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }]);
  assert.deepEqual(left.hooks.Notification, [{ hooks: [{ type: 'command', command: 'say done' }] }]);
  assert.equal('PostToolUse' in left.hooks, false);
  assert.equal('UserPromptSubmit' in left.hooks, false);
});

test('claude-code: a broken or non-object settings file stops install and uninstall, unchanged', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.claude', 'settings.json');
  write(file, '{ "hooks": ');
  assert.throws(() => claude.install(opts(h)), /cannot parse/);
  assert.throws(() => claude.uninstall(opts(h)), /cannot parse/);
  assert.equal(text(file), '{ "hooks": ');
});

test('claude-code: an empty settings file is treated as an empty one', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.claude', 'settings.json');
  write(file, '   ');
  claude.install(opts(h));
  assert.equal(Object.keys(json(file).hooks).length, 4);
});

test('claude-code: uninstall when nothing is installed changes nothing and creates nothing', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.claude', 'settings.json');
  const r = claude.uninstall(opts(h));
  assert.deepEqual([r.removed, r.backup, r.warnings], [0, null, []]);
  assert.equal(fs.existsSync(file), false);
  // A settings file with no hooks at all: also untouched.
  write(file, '{"model":"opus"}\n');
  const r2 = claude.uninstall(opts(h));
  assert.equal(r2.removed, 0);
  assert.equal(r2.backup, null);
  assert.equal(text(file), '{"model":"opus"}\n');
});

test('claude-code: Windows install writes forward-slash commands, and uninstall still finds them', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.claude', 'settings.json');
  const win = opts(h, {
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    runnerPath: 'C:\\zn\\lib\\hooks\\runner.js',
  });
  claude.install(win);
  const cmd = json(file).hooks.PreToolUse[0].hooks[0].command;
  assert.equal(cmd, "'C:/Program Files/nodejs/node.exe' 'C:/zn/lib/hooks/runner.js' claude-code");
  assert.equal(claude.uninstall(win).removed, 1);
});

test('claude-code: with no claude CLI on PATH, the MCP server is left for the user to add', (t) => {
  const h = fakeHome(t);
  const r = claude.install(opts(h, { mcp: true, claudeBin: null }));
  assert.equal(r.mcp, undefined);
  assert.ok(r.warnings.some((w) => /`claude` CLI not found: register the MCP server yourself with: claude mcp add --scope user secrets/.test(w)));
});

test('claude-code: a batch-file claude is never started through cmd.exe', (t) => {
  const h = fakeHome(t);
  const r = claude.install(opts(h, { mcp: true, claudeBin: 'C:\\tools\\claude.cmd' }));
  assert.ok(r.warnings.some((w) => /is a batch file \(.*claude\.cmd\)/.test(w)));
  assert.equal(r.mcp, undefined);
});

test('claude-code: a failing claude mcp add-json is reported, not thrown', (t) => {
  const h = fakeHome(t);
  // node cannot run `mcp add-json ...` as a script, so the command exits non-zero.
  const r = claude.install(opts(h, { mcp: true, claudeBin: process.execPath }));
  assert.ok(r.warnings.some((w) => /`claude mcp add-json` failed/.test(w)));
});

test('claude-code: project scope keeps a foreign "secrets" MCP server and removes only zn\'s', (t) => {
  const h = fakeHome(t);
  const project = path.join(h, 'project');
  const mcpFile = path.join(project, '.mcp.json');
  write(mcpFile, JSON.stringify({ mcpServers: { secrets: { command: 'other-tool' } } }));
  const r = claude.install(opts(h, { mcp: true, scope: 'project', projectDir: project }));
  assert.ok(r.warnings.some((w) => /already exists/.test(w)));
  assert.deepEqual(json(mcpFile).mcpServers.secrets, { command: 'other-tool' });

  write(mcpFile, JSON.stringify({ mcpServers: { secrets: ZN_SERVER } }));
  claude.uninstall(opts(h, { mcp: true, scope: 'project', projectDir: project }));
  assert.equal('secrets' in json(mcpFile).mcpServers, false);
  // No .mcp.json at all: nothing to remove.
  fs.rmSync(mcpFile);
  const none = claude.uninstall(opts(h, { mcp: true, scope: 'project', projectDir: project }));
  assert.deepEqual(none.warnings, []);
  assert.equal(fs.existsSync(mcpFile), false);
});

test('claude-code: uninstall reports an unreadable user MCP config and leaves the server', (t) => {
  const h = fakeHome(t);
  write(path.join(h, '.claude.json'), '{ "mcpServers": ');
  const r = claude.uninstall(opts(h, { mcp: true, claudeBin: null }));
  assert.ok(r.warnings.some((w) => /could not read your Claude Code MCP settings/.test(w)));
});

test('claude-code: uninstall removes zn\'s own user MCP server, but says so when claude is not on PATH', (t) => {
  const h = fakeHome(t);
  write(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { secrets: ZN_SERVER } }));
  const r = claude.uninstall(opts(h, { mcp: true, claudeBin: null }));
  assert.ok(r.warnings.some((w) => /is not on your PATH: remove zn's MCP server yourself/.test(w)));
});

test('claude-code: uninstall keeps someone else\'s user "secrets" server', (t) => {
  const h = fakeHome(t);
  write(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { secrets: { command: 'other-tool' } } }));
  const r = claude.uninstall(opts(h, { mcp: true, claudeBin: null }));
  assert.ok(r.warnings.some((w) => /left the MCP server named "secrets" in place: it is not zn's/.test(w)));
});

test('claude-code: uninstall with no user .claude.json has nothing to say about MCP', (t) => {
  const h = fakeHome(t);
  const r = claude.uninstall(opts(h, { mcp: true, claudeBin: null }));
  assert.deepEqual(r.warnings, []);
});

test('claude-code: the managed policy is reported on install when present, and not when absent', (t) => {
  const h = fakeHome(t);
  const managed = path.join(h, 'managed');
  write(path.join(managed, 'managed-settings.json'), JSON.stringify({ disableAllHooks: true }));
  const present = claude.install(opts(h, { managedDir: managed }));
  assert.ok(present.warnings.some((w) => /turns off all hooks \(disableAllHooks\)/.test(w)));

  const h2 = fakeHome(t);
  const absent = claude.install(opts(h2, { managedDir: path.join(h2, 'no-policy') }));
  assert.deepEqual(absent.warnings, []);
});

/* ------------------------------- managed-policy ------------------------------- */

function policy(t, { managed, mcpFile, user } = {}) {
  const h = fakeHome(t);
  const dir = path.join(h, 'managed');
  if (managed !== undefined) write(path.join(dir, 'managed-settings.json'), managed);
  if (mcpFile !== undefined) write(path.join(dir, 'managed-mcp.json'), mcpFile);
  const userFile = path.join(h, 'settings.json');
  if (user !== undefined) write(userFile, JSON.stringify(user));
  return { managedDir: dir, userSettings: [userFile], mcp: true, mcpCommand: CMD };
}

test('managed-policy: no policy files, or a policy directory that does not exist, gives no warning', (t) => {
  assert.deepEqual(claudeCodePolicyWarnings(policy(t)), []);
  const h = fakeHome(t);
  assert.deepEqual(claudeCodePolicyWarnings({ managedDir: path.join(h, 'nope'), userSettings: [], mcp: true, mcpCommand: CMD }), []);
});

test('managed-policy: unreadable or non-object managed settings are reported', (t) => {
  let w = claudeCodePolicyWarnings(policy(t, { managed: '{ not json' }));
  assert.ok(w.some((x) => /could not read the Claude Code managed settings .*\(invalid JSON\)/.test(x)));
  w = claudeCodePolicyWarnings(policy(t, { managed: '[1]' }));
  assert.ok(w.some((x) => /\(not a JSON object\)/.test(x)));
});

test('managed-policy: managed hooks that are not zn\'s do not satisfy allowManagedHooksOnly', (t) => {
  const managed = JSON.stringify({
    allowManagedHooksOnly: true,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo corp' }] }] },
  });
  const w = claudeCodePolicyWarnings(policy(t, { managed }));
  assert.equal(w.length, 1);
  assert.match(w[0], /runs only the hooks in its managed settings \(allowManagedHooksOnly\)/);
});

test('managed-policy: managed hooks that include zn\'s command satisfy allowManagedHooksOnly', (t) => {
  const managed = JSON.stringify({
    allowManagedHooksOnly: true,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "'/usr/bin/node' '/opt/zn/lib/hooks/runner.js' claude-code" }] }] },
  });
  assert.deepEqual(claudeCodePolicyWarnings(policy(t, { managed })), []);
});

test('managed-policy: an unreadable managed-mcp.json is reported', (t) => {
  const w = claudeCodePolicyWarnings(policy(t, { mcpFile: '{ "mcpServers": ' }));
  assert.ok(w.some((x) => /could not read .*managed-mcp\.json \(invalid JSON\)/.test(x)));
});

test('managed-policy: a user disableAllHooks is reported when no managed policy turns hooks off', (t) => {
  const w = claudeCodePolicyWarnings(policy(t, { user: { disableAllHooks: true } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /sets disableAllHooks, so no hooks you install run/);
});

test('managed-policy: the policy directory is per platform', () => {
  assert.equal(managedDir('win32'), 'C:\\Program Files\\ClaudeCode');
  assert.equal(managedDir('darwin'), '/Library/Application Support/ClaudeCode');
  assert.equal(managedDir('linux'), '/etc/claude-code');
});

/* ------------------------------------ cursor ------------------------------------ */

test('cursor: uninstall when nothing is installed creates nothing and changes nothing', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.cursor', 'hooks.json');
  const r = cursor.uninstall(opts(h));
  assert.deepEqual([r.removed, r.backup], [0, null]);
  assert.equal(fs.existsSync(file), false);
  write(file, '{"version":1}');
  const r2 = cursor.uninstall(opts(h));
  assert.equal(r2.removed, 0);
  assert.equal(text(file), '{"version":1}');
});

test('cursor: install keeps the user\'s other hooks and uninstall leaves them', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.cursor', 'hooks.json');
  write(file, JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: 'echo mine' }], customEvent: [{ command: 'x' }] } }));
  const r = cursor.install(opts(h));
  assert.notEqual(r.backup, null);
  const after = json(file);
  assert.equal(after.hooks.beforeReadFile[0].command, 'echo mine');
  assert.equal(after.hooks.beforeReadFile.length, 2);
  assert.deepEqual(after.hooks.customEvent, [{ command: 'x' }]);

  const u = cursor.uninstall(opts(h));
  assert.equal(u.removed, 1);
  const left = json(file);
  assert.deepEqual(left.hooks.beforeReadFile, [{ command: 'echo mine' }]);
  assert.deepEqual(left.hooks.customEvent, [{ command: 'x' }]);
});

test('cursor: a hooks value that is not an object stops install, and a broken file stops uninstall', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.cursor', 'hooks.json');
  write(file, '{"hooks": []}');
  assert.throws(() => cursor.install(opts(h)), /"hooks" in .* must be an object, not an array/);
  write(file, '{ broken');
  assert.throws(() => cursor.uninstall(opts(h)), /cannot parse/);
  assert.equal(text(file), '{ broken');
});

test('cursor: on win32 each hook runs through powershell.exe, and uninstall finds them', (t) => {
  const h = fakeHome(t);
  const file = path.join(h, '.cursor', 'hooks.json');
  const win = opts(h, { platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: 'C:\\zn\\lib\\hooks\\runner.js' });
  cursor.install(win);
  const hooks = json(file).hooks;
  for (const entries of Object.values(hooks)) {
    for (const e of entries) assert.match(e.command, /^powershell\.exe /);
  }
  assert.equal(cursor.uninstall(win).removed, 1);
  assert.deepEqual(json(file).hooks, {});
});

test('cursor: an event name it does not know is not a hook event', () => {
  assert.equal(cursor.normalize({ hook_event_name: 'nope' }).event, null);
});

/* ------------------------------------ opencode ------------------------------------ */

test('opencode: install, uninstall and a second uninstall', (t) => {
  const h = fakeHome(t);
  const o = opts(h);
  const file = opencode.pluginPath(o);
  assert.equal(file, path.join(h, '.config', 'opencode', 'plugins', path.basename(file)));
  const r = opencode.install(o);
  assert.equal(r.settings, file);
  assert.equal(fs.existsSync(file), true);
  assert.equal(opencode.uninstall(o).removed, 1);
  assert.equal(fs.existsSync(file), false);
  const again = opencode.uninstall(o);
  assert.deepEqual([again.removed, again.backup], [0, null]);
});

test('opencode: XDG_CONFIG_HOME moves the plugin folder', (t) => {
  const h = fakeHome(t);
  const xdg = path.join(h, 'xdg');
  const file = opencode.pluginPath({ home: h, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(file, path.join(xdg, 'opencode', 'plugins', path.basename(file)));
});

test('opencode: a plugin file zn did not write is refused on install and left on uninstall', (t) => {
  const h = fakeHome(t);
  const o = opts(h);
  const file = opencode.pluginPath(o);
  write(file, '// someone else\n');
  assert.throws(() => opencode.install(o), /exists and was not written by zn; left unchanged/);
  assert.equal(opencode.uninstall(o).removed, 0);
  assert.equal(text(file), '// someone else\n');
});

test('opencode: a project plugin calls zn on PATH; a user plugin names this node and runner', (t) => {
  const h = fakeHome(t);
  const project = opencode.pluginSource({ scope: 'project', projectDir: h });
  assert.match(project, /const NODE = "zn";/);
  assert.match(project, /\["hook", "opencode"\]/);
  const user = opencode.pluginSource({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: 'C:\\zn\\lib\\hooks\\runner.js' });
  assert.match(user, /const NODE = "C:\/Program Files\/nodejs\/node\.exe";/);
  assert.match(user, /const RUNNER = "C:\/zn\/lib\/hooks\/runner\.js";/);
  assert.equal(path.dirname(opencode.pluginPath({ scope: 'project', projectDir: h })), path.join(path.resolve(h), '.opencode', 'plugins'));
});

test('opencode: an unknown event type is not a hook event', () => {
  assert.equal(opencode.normalize({ type: 'nope', args: {} }).event, null);
});
