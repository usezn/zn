'use strict';

/**
 * zn team managed-config: PRINTS the files an administrator deploys with MDM or
 * configuration management so that zn-gate's hooks run for every developer.
 * It never writes a file and never reads the machine: the output depends only
 * on the options.
 *
 *   zn team managed-config [--agent claude-code|cursor|codex|all] [--os macos|linux|windows|all]
 *                          [--managed-hooks-only] [--exclusive-mcp] [--zn-path ABSOLUTE_PATH] [--json]
 *
 * The hook commands are the ones `zn hooks install --scope project` writes
 * (`zn hook <agent>`, see lib/agents/config-file.js hookCommand), so each
 * machine needs zn-gate installed with `zn` on the PATH (or at the --zn-path), and the policy check
 * of `zn hooks install` (lib/agents/managed-policy.js) recognizes them as zn's.
 *
 * Formats, read 2026-10-19 (re-read for this command):
 *  Claude Code
 *    https://code.claude.com/docs/en/managed-settings
 *      managed-settings.json: macOS /Library/Application Support/ClaudeCode/,
 *      Linux and WSL /etc/claude-code/, Windows C:\Program Files\ClaudeCode\
 *      (not the legacy C:\ProgramData\ClaudeCode); optional managed-settings.d/*.json.
 *    https://code.claude.com/docs/en/hooks
 *      { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "...", "timeout": N } ] } ] } }
 *      allowManagedHooksOnly: user, project, local and plugin hooks stop; managed hooks keep running.
 *    https://code.claude.com/docs/en/managed-mcp
 *      managedMcpServers takes only http/sse entries with an https url and no command, so a
 *      stdio server such as zn's "secrets" server cannot go there. A stdio server can be
 *      deployed only in managed-mcp.json, which takes exclusive control of MCP (same folder
 *      as managed-settings.json). Hence --exclusive-mcp is opt in.
 *  Cursor
 *    https://cursor.com/docs/hooks
 *      hooks.json { "version": 1, "hooks": { "<event>": [ { "command", "timeout", "failClosed", "matcher" } ] } };
 *      enterprise file: macOS /Library/Application Support/Cursor/hooks.json, Linux and WSL
 *      /etc/cursor/hooks.json, Windows C:\ProgramData\Cursor\hooks.json; priority Enterprise,
 *      Team, Project, User. failClosed (default false) blocks the action when the hook
 *      crashes, times out, exits non-zero or prints nothing.
 *  Codex
 *    https://learn.chatgpt.com/docs/enterprise/managed-configuration
 *      (developers.openai.com/codex/enterprise/managed-configuration redirects there)
 *      requirements.toml: Linux and macOS /etc/codex/requirements.toml, Windows
 *      %ProgramData%\OpenAI\Codex\requirements.toml; macOS MDM is a base64 payload
 *      (requirements_toml_base64) in the com.openai.codex preference domain.
 *      allow_managed_hooks_only = true, [features] hooks = true, and managed hooks as
 *      [[hooks.<Event>]] (matcher) with nested [[hooks.<Event>.hooks]] (type, command,
 *      command_windows, timeout, statusMessage).
 */

const claude = require('../agents/claude-code');
const cursor = require('../agents/cursor');
const codex = require('../agents/codex');
const launcher = require('../agents/launcher');
const { managedDir } = require('../agents/managed-policy');

const fs = require('fs');
const os_ = require('os');
const path = require('path');

const READ_DATE = '2026-10-19';
const AGENTS = ['claude-code', 'cursor', 'codex'];
const OSES = ['macos', 'linux', 'windows'];
const PLATFORM = { macos: 'darwin', linux: 'linux', windows: 'win32' };
const OS_NAME = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };
const AGENT_NAME = { 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex' };
const DOCS = {
  'claude-code': 'https://code.claude.com/docs/en/managed-settings',
  cursor: 'https://cursor.com/docs/hooks',
  codex: 'https://learn.chatgpt.com/docs/enterprise/managed-configuration',
};

const USAGE = 'usage: zn team managed-config [--agent claude-code|cursor|codex|all] [--os macos|linux|windows|all] [--managed-hooks-only] [--exclusive-mcp] [--zn-path ABSOLUTE_PATH [--node-path ABSOLUTE_PATH]] [--json]';
const INSTALL_NOTE = 'zn-gate must be installed on each machine with `zn` on the PATH (npm install -g zn-gate).';
const PIN_ADVICE = 'The hook runs the first `zn` on the developer\'s PATH, so a program named zn that a developer puts earlier on the PATH replaces it. To close that, pass --zn-path with the absolute path of zn on your machines, in a folder only administrators can write to.';
const pinNote = (zn) => (zn ? 'The hooks run zn at exactly ' + zn.path + ' and never search the PATH for it; zn-gate must be installed there on every machine, and ' + (zn.node ? 'Node.js is run only from exactly ' + zn.node.path + ' (a node earlier on the PATH is refused; it must be installed there on every machine). ' : 'Node.js is still the first node on the developer\'s PATH unless it sits next to zn: pass --node-path to pin it too. ') + (zn.checked ? 'This path was checked on this computer.' : 'This path was not checked on this computer because it is for another system: check it there.') : PIN_ADVICE);

// The hooks run `zn` from the PATH inside zn's start guard, as a project install writes them (launcher.projectShCommand):
// a missing zn or Node.js blocks, and neither zn, node nor powershell.exe can come from the folder the agent runs in.
// On Windows, Codex runs command_windows through cmd.exe, so it names powershell.exe through %SystemRoot%.
// zn: the validated --zn-path ({path, os}) or undefined. Claude Code on Windows runs sh (Git Bash), so a drive path becomes /c/dir/zn.cmd there.
const shPath = (zn) => (zn.os === 'windows' ? '/' + zn.path[0].toLowerCase() + zn.path.slice(2).split(String.fromCharCode(92)).join('/') : zn.path);
const shGuard = (agent, zn) => (event) => launcher.projectShCommand(agent, event, zn ? { znPath: shPath(zn), ...(zn.node ? { nodePath: shPath(zn.node) } : {}) } : {});
const winGuard = (agent, zn, opts) => (event) => launcher.windowsScriptCommand(launcher.projectWindowsScript(agent, event, zn ? { znPath: zn.path, ...(zn.node ? { nodePath: zn.node.path } : {}) } : {}), opts);

/* The first folder a user can write to that holds p (the project folder, home, a temp folder), or undefined. */
function userWritable(p, hostWin) {
  const norm = (x) => (hostWin ? path.resolve(x).toLowerCase() : path.resolve(x));
  const under = (x, dir) => { const a = norm(x); const b = norm(dir); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };
  const zones = [os_.homedir(), os_.tmpdir(), '/tmp', '/var/tmp'];
  const cwd = process.cwd();
  if (path.dirname(cwd) !== cwd) zones.push(cwd);
  return zones.find((z) => z && path.dirname(path.resolve(z)) !== path.resolve(z) && under(p, z));
}

/**
 * Checks --zn-path for one target system and returns {path, os, checked}; throws a message the administrator can act on.
 * The shape is always checked. The file itself (exists, runs, not in a folder a user can write) is checked only when the
 * target system is the one this runs on; for another system the path cannot be looked at from here.
 */
function checkZnPath(p, os, flag = '--zn-path') {
  const win = os === 'windows';
  const node = flag === '--node-path';
  if (typeof p !== 'string' || !p) throw new Error(flag + ' needs a value');
  const shapeOk = node
    ? (win ? launcher.PINNED_WIN_PATH.test(p) && /\x5cnode\.exe$/i.test(p) : launcher.PINNED_SH_PATH.test(p) && /\/node$/.test(p))
    : (win ? launcher.PINNED_WIN_PATH.test(p) && /[.](cmd|exe)$/i.test(p) : launcher.PINNED_SH_PATH.test(p));
  if (!shapeOk || p.includes('..')) {
    throw new Error(flag + ' must be an absolute path to the ' + (node ? 'node program' : 'zn program') + ' on the target system, with no "..": ' +
      (win ? 'a drive path ending in ' + (node ? 'node.exe' : 'zn.cmd or zn.exe') + ', using letters, digits, spaces and . _ + @ ( ) -' : 'for example ' + (node ? '/usr/local/bin/node' : '/usr/local/bin/zn') + ', using letters, digits, spaces and . _ + @ : -'));
  }
  if (os !== osDefault()) return { path: p, os, checked: false };
  let real;
  try { real = fs.realpathSync(p); } catch (_) { throw new Error(flag + ' ' + p + ' does not exist on this computer. Install zn-gate there first, or run this on a machine that has it.'); }
  let st;
  try { st = fs.statSync(real); } catch (_) { throw new Error(flag + ' ' + p + ' cannot be read'); }
  if (!st.isFile()) throw new Error(flag + ' ' + p + ' is not a file');
  if (!win) { try { fs.accessSync(real, fs.constants.X_OK); } catch (_) { throw new Error(flag + ' ' + p + ' is not executable'); } }
  const bad = userWritable(p, win) || userWritable(real, win);
  if (bad) throw new Error(flag + ' ' + p + ' is inside ' + bad + ', a folder a user can write to, so a developer or an agent could replace it. Install zn-gate in a folder only administrators can write to, such as /usr/local/bin or C:' + String.fromCharCode(92) + 'Program Files.');
  if (!win) {
    for (const start of [p, real]) {
      for (let x = start; ; x = path.dirname(x)) {
        const sx = fs.statSync(x);
        if ((sx.mode & 0o022) && !(sx.isDirectory() && (sx.mode & 0o1000))) throw new Error(flag + ' ' + p + ': ' + x + ' can be written by users other than its owner (group or world write), so it could be replaced. Fix its permissions or choose another install folder.');
        if (path.dirname(x) === x) break;
      }
    }
  }
  return { path: p, os, checked: true };
}

function osDefault() {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
}

/* A Windows path is joined with a backslash, any other with a slash. */
function join(os, dir, name) {
  return dir + (os === 'windows' ? '\\' : '/') + name;
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

/* TOML basic string: every string here is plain ASCII, so JSON quoting is valid TOML. */
const t = (s) => JSON.stringify(s);

function codexToml(opts) {
  const lines = ['# zn-gate hooks for Codex (zn team managed-config).'];
  if (opts.managedHooksOnly) lines.push('allow_managed_hooks_only = true');
  lines.push('', '[features]', 'hooks = true');
  const h = {
    type: 'command',
    timeout: codex.HOOK_TIMEOUT_S,
    statusMessage: codex.HOOK_STATUS,
  };
  const handler = (event) => ({ ...h, command: shGuard('codex', opts.zn)(event), commandWindows: winGuard('codex', opts.zn, { cmd: true })(event) });
  for (const [event, group] of Object.entries(codex.hookGroups(handler))) {
    lines.push('', '[[hooks.' + event + ']]');
    if (group.matcher !== undefined) lines.push('matcher = ' + t(group.matcher));
    for (const x of group.hooks) {
      lines.push('', '[[hooks.' + event + '.hooks]]', 'type = ' + t(x.type), 'command = ' + t(x.command),
        'command_windows = ' + t(x.commandWindows), 'timeout = ' + x.timeout, 'statusMessage = ' + t(x.statusMessage));
    }
  }
  return lines.join('\n') + '\n';
}

function claudeFiles(os, opts) {
  const dir = managedDir(PLATFORM[os]);
  // ourHooks gives one matcher group per event; settings hold a list of groups per event.
  // Claude Code runs hook commands through sh (Git Bash on Windows), so every OS gets the sh guard.
  const settings = { hooks: Object.fromEntries(Object.entries(claude.ourHooks(shGuard('claude-code', opts.zn))).map(([e, g]) => [e, [g]])) };
  if (opts.managedHooksOnly) settings.allowManagedHooksOnly = true;
  const files = [{
    file: join(os, dir, 'managed-settings.json'),
    format: 'json',
    content: json(settings),
    notes: [
      'If this file already exists, merge the "hooks" entries into it, or save this as managed-settings.d/50-zn.json in the same folder: Claude Code merges the files in that folder with managed-settings.json.',
      INSTALL_NOTE,
      pinNote(opts.zn),
      opts.managedHooksOnly
        ? 'allowManagedHooksOnly is on: Claude Code runs only managed hooks, so developers\' own user, project and plugin hooks stop running. Put any hooks you still want in managed settings.'
        : 'allowManagedHooksOnly is off, so developers keep their own hooks. Add --managed-hooks-only to run only managed hooks.',
      'An MDM profile (macOS) or the Windows registry can carry the same settings; Claude Code selects one managed source, and `claude doctor` shows which.',
      'To allow zn\'s MCP server under an existing allowedMcpServers list, add { "serverCommand": [' + JSON.stringify(opts.zn ? opts.zn.path : 'zn') + ', "secrets-mcp", "--agent", "claude-code"] }. managedMcpServers cannot carry it: it accepts only https http/sse entries with no command.',
    ],
  }];
  if (opts.exclusiveMcp) {
    files.push({
      file: join(os, dir, 'managed-mcp.json'),
      format: 'json',
      content: json({ mcpServers: { secrets: { type: 'stdio', command: opts.zn ? opts.zn.path : 'zn', args: ['secrets-mcp', '--agent', 'claude-code'] } } }),
      notes: [
        'WARNING: managed-mcp.json takes exclusive control of MCP. Claude Code then loads only the servers in this file (plus managedMcpServers), and developers cannot add others. Add every server your organization approves to this file before you deploy it.',
      ],
    });
  }
  return files;
}

function cursorFiles(os, opts) {
  // Cursor wraps hook commands in PowerShell on Windows: the PowerShell form of the guard there.
  const entries = cursor.hookEntries(os === 'windows' ? winGuard('cursor', opts.zn) : shGuard('cursor', opts.zn));
  const notes = [
    'If this file already exists, merge the "hooks" entries into it.',
    'failClosed is on for beforeReadFile and beforeSubmitPrompt: if the hook crashes, times out or prints nothing, Cursor blocks the read or the prompt.',
    'The enterprise file ranks above team, project and user hooks. Cursor documents no setting that stops a developer from adding hooks of their own, and none that deploys zn\'s MCP server.',
    INSTALL_NOTE,
    pinNote(opts.zn),
  ];
  if (opts.managedHooksOnly || opts.exclusiveMcp) notes.push('--managed-hooks-only and --exclusive-mcp change nothing for Cursor.');
  return [{
    file: os === 'macos' ? '/Library/Application Support/Cursor/hooks.json'
      : os === 'linux' ? '/etc/cursor/hooks.json' : 'C:\\ProgramData\\Cursor\\hooks.json',
    format: 'json',
    content: json({ version: 1, hooks: Object.fromEntries(Object.entries(entries).map(([e, h]) => [e, [h]])) }),
    notes,
  }];
}

function codexFiles(os, opts) {
  const notes = [
    'If this file already exists, merge these keys and tables into it.',
    'macOS MDM can deliver the same TOML as a base64 payload (requirements_toml_base64) in the com.openai.codex preference domain; a higher-precedence layer overrides this file.',
    '[features] hooks = true makes the hooks apply even when a developer turned hooks off in their own config.toml.',
    opts.managedHooksOnly
      ? 'allow_managed_hooks_only is on: Codex skips user, project, session and plugin hooks, so developers\' own hooks stop running.'
      : 'allow_managed_hooks_only is off, so developers keep their own hooks. Add --managed-hooks-only to run only managed hooks.',
    INSTALL_NOTE,
    pinNote(opts.zn),
    'No [mcp_servers] entry is printed: in requirements.toml that table is an approved list matched by command or URL. If you use it, add zn\'s "secrets" server to it yourself.',
  ];
  if (opts.exclusiveMcp) notes.push('--exclusive-mcp changes nothing for Codex.');
  return [{
    file: os === 'windows' ? '%ProgramData%\\OpenAI\\Codex\\requirements.toml' : '/etc/codex/requirements.toml',
    format: 'toml',
    content: codexToml(opts),
    notes,
  }];
}

const BUILDERS = { 'claude-code': claudeFiles, cursor: cursorFiles, codex: codexFiles };

/**
 * build({agent, os, managedHooksOnly, exclusiveMcp}) -> [{agent, os, file, format, content, notes, docs, read}]
 * agent and os may be 'all'. Pure: no file is read or written.
 */
function build(opts = {}) {
  const agents = !opts.agent || opts.agent === 'all' ? AGENTS : [opts.agent];
  const oses = !opts.os || opts.os === 'all' ? OSES : [opts.os];
  if (opts.nodePath !== undefined && opts.znPath === undefined) throw new Error('--node-path needs --zn-path too: with zn still found on the PATH, a fake zn would replace the hook before node matters');
  if ((opts.znPath !== undefined || opts.nodePath !== undefined) && oses.length !== 1) throw new Error('--zn-path and --node-path are paths on one system: also pass --os macos, --os linux or --os windows');
  const out = [];
  for (const agent of agents) {
    if (!BUILDERS[agent]) throw new Error('unknown agent "' + agent + '" (choose claude-code, cursor, codex or all)');
    for (const os of oses) {
      if (!PLATFORM[os]) throw new Error('unknown os "' + os + '" (choose macos, linux, windows or all)');
      const zn = opts.znPath === undefined ? undefined : checkZnPath(opts.znPath, os);
      if (zn && opts.nodePath !== undefined) zn.node = checkZnPath(opts.nodePath, os, '--node-path');
      for (const f of BUILDERS[agent](os, { ...opts, zn })) out.push({ agent, os, ...f, docs: DOCS[agent], read: READ_DATE });
    }
  }
  return out;
}

function parseArgs(args) {
  const o = { agent: 'all', os: osDefault(), managedHooksOnly: false, exclusiveMcp: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(a + ' needs a value');
      return args[++i];
    };
    if (a === '--agent') { const v = val(); o.agent = v === 'claude' ? 'claude-code' : v; }
    else if (a === '--os') o.os = val();
    else if (a === '--managed-hooks-only') o.managedHooksOnly = true;
    else if (a === '--exclusive-mcp') o.exclusiveMcp = true;
    else if (a === '--zn-path') o.znPath = val();
    else if (a === '--node-path') o.nodePath = val();
    else if (a === '--json') o.json = true;
    else throw new Error('unknown option ' + a);
  }
  return o;
}

function text(files) {
  const lines = ['Nothing is written: copy each file to the path shown, with your MDM or configuration tool.', ''];
  for (const f of files) {
    lines.push('=== ' + AGENT_NAME[f.agent] + ' on ' + OS_NAME[f.os] + ' ===', 'File: ' + f.file,
      'Format read from ' + f.docs + ' on ' + f.read, '', f.content.replace(/\n$/, ''), '');
    for (const n of f.notes) lines.push('- ' + n);
    lines.push('');
  }
  return lines.join('\n');
}

/** Returns the process exit code. */
function run(args, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => process.stderr.write(s));
  if (args.some((a) => a === '-h' || a === '--help')) {
    out(USAGE + '\nPrints the managed configuration an administrator deploys with MDM so that zn-gate\'s hooks run for every developer. Nothing is written.\n');
    return 0;
  }
  let o;
  let files;
  try {
    o = parseArgs(args);
    files = build(o);
  } catch (e) {
    err('zn team managed-config: ' + e.message + '\n' + USAGE + '\n');
    return 2;
  }
  out(o.json ? JSON.stringify({ schema: 1, files }, null, 2) + '\n' : text(files));
  return 0;
}

module.exports = { run, build, checkZnPath, AGENTS, OSES, READ_DATE };
