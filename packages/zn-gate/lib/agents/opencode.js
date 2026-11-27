'use strict';

/**
 * OpenCode adapter: a plugin that calls the zn hook runner.
 *
 * Plugin API (opencode.ai/docs/plugins and the OpenCode source at v1.18.25,
 * read 2026-10-11):
 *  - Plugins load from ~/.config/opencode/plugins/ (user) and
 *    <project>/.opencode/plugins/ (project); `plugin/` also works.
 *  - "tool.execute.before"(input {tool, sessionID, callID}, output {args}):
 *    mutating output.args in place changes the call; throwing blocks it.
 *    OpenCode's own permission rules still apply afterwards, so a rewrite
 *    never approves anything by itself.
 *  - "tool.execute.after"(input {tool, sessionID, callID, args},
 *    output {title, output, metadata}): mutating output.output in place
 *    changes what the model sees. MCP tools hand over the raw MCP result
 *    (content[].text), which is rewritten in place too, and so is
 *    output.metadata (the TUI's preview of the output, kept in OpenCode's
 *    local database). Metadata that OpenCode writes while a command is still
 *    running is stored before the hook runs and is out of its reach.
 *  - "chat.message"(input, output {message, parts}): runs before the user's
 *    message is stored and sent; throwing stops it.
 *  - Tool ids and arguments: bash {command}, read {filePath},
 *    write {filePath, content}, edit {filePath, oldString, newString},
 *    grep {pattern, path}, webfetch {url}, apply_patch {patchText}, lsp;
 *    MCP tools are <server>_<tool>.
 *
 * The plugin (written by `zn hooks install opencode`) sends each event to
 * `node lib/hooks/runner.js opencode` on stdin and applies the answer:
 *   {action: "deny", message}            throw (the call or the message is blocked)
 *   {action: "args", args, message}      set those args in place
 *   {action: "output", output, content}  set the tool output in place
 *   {action: "none"}
 * A runner that fails or answers garbage fails closed in the plugin.
 *
 * Do not rely on OpenCode's shell.env to pass secrets (issue #41117): zn
 * rewrites the command itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { whichSync } = require('../broker/markers');
const { askAsDeny, isPlainAsk } = require('./ask-deny');
const { writeFileAtomic } = require('../broker/files');
const cfg = require('./config-file');
const { patchScan, PATCH_SCAN_CAP } = require('./codex');
const { cliName } = require('../zn-command');
const { LOADER_SOURCE } = require('../loader-env');

const id = 'opencode';
const PLUGIN_FILE = 'zn-gate.js';
const PLUGIN_MARK = '// zn-gate plugin for OpenCode';
const BUILTIN = new Set(['bash', 'read', 'write', 'edit', 'grep', 'glob', 'webfetch', 'websearch', 'apply_patch', 'task', 'todowrite', 'todoread', 'todo', 'skill', 'question', 'plan', 'list', 'patch', 'multiedit', 'lsp']);

const TOKENIZED_OUTPUT = new Set(['task', 'websearch', 'glob', 'list', 'skill', 'codesearch']);
// Built-ins whose arguments leave the machine (the query goes to a search service): checked before they run like an MCP
// call to an unknown server, so a secret or a marker in the query is refused. task, glob, list and skill stay local.
const OUTBOUND_QUERY = new Set(['websearch', 'codesearch']);

function textsOf(tool, args) {
  const texts = [];
  const add = (key, v) => { if (typeof v === 'string') texts.push({ key: [key], value: v }); };
  if (tool === 'write') add('content', args.content);
  if (tool === 'edit') { add('oldString', args.oldString); add('newString', args.newString); }
  if (tool === 'apply_patch') add('patchText', args.patchText);
  return texts;
}

// The plugin sends the base name of $SHELL (never a path; empty when unset) and process.platform.
// powershell.exe, pwsh and pwsh-preview all count as PowerShell.
function shellBase(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
}
function isPowerShellName(name) {
  const base = shellBase(name);
  return base === 'powershell' || /^pwsh(-preview)?$/.test(base);
}
const BASH_LIKE = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
// Mirrors OpenCode's own choice (packages/core/src/shell/select.ts): on Windows it uses $SHELL
// when that names a usable shell and otherwise picks pwsh, then powershell, then Git Bash, then
// cmd.exe. So on Windows an unset or non-bash $SHELL means PowerShell; elsewhere only an
// explicit PowerShell name does. Measured with OpenCode 1.19.3 on Windows Server 2022.
function usesPowerShell(shell, platform) {
  if (isPowerShellName(shell)) return true;
  if (platform !== 'win32') return false;
  return !BASH_LIKE.has(shellBase(shell));
}

/* ---------------------- which MCP server a tool belongs to ---------------------- */

// OpenCode names an MCP tool <server>_<tool>, both parts with every character outside [A-Za-z0-9_-] turned into "_".
function mcpSafeName(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }

/* Whether a file is inside the project: the working folder or, when there is one above, the git work tree (the folders
 * OpenCode reads project files from), by the path as written and once links are resolved. */
function insideProject(root, file) {
  const start = path.resolve(root);
  // Outside means the parent segment itself (".." or "../..."): a folder named "..secrets" is inside.
  const within = (d, f) => { const rel = path.relative(d, f); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  let top = start;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) { top = dir; break; }
    if (path.dirname(dir) === dir) break;
  }
  return within(real(top), real(file)) || within(top, path.resolve(file));
}

/* The MCP servers OpenCode's configuration files define, by name: { servers: Map(name -> [{ cfg, user }]), ok }.
 * user is true only for an entry of the user-level configuration (the user's own config folder, OPENCODE_CONFIG_DIR
 * and OPENCODE_CONFIG, when that file is not inside the project); the project files and OPENCODE_CONFIG_CONTENT are not.
 * ok is false when a file that exists cannot be read or parsed (or a config variable is not valid JSON): nothing is
 * then trusted as zn's own server. A missing file is normal. */
function readMcpServers(root, env) {
  const { parseJsonc } = require('../audit/parse');
  const servers = new Map();
  let ok = true;
  const take = (data, user) => {
    const m = data && typeof data === 'object' && data.mcp && typeof data.mcp === 'object' && !Array.isArray(data.mcp) ? data.mcp : null;
    if (!m) return;
    for (const name of Object.keys(m)) {
      const key = mcpSafeName(name);
      if (!servers.has(key)) servers.set(key, []);
      servers.get(key).push({ cfg: m[name], user });
    }
  };
  const start = path.resolve(root);
  const readFile = (file, user) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return; ok = false; return; }
    try { take(parseJsonc(text), Boolean(user) && !insideProject(root, file)); } catch (_) { ok = false; }
  };
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  const dirs = [path.join(base, 'opencode')];
  if (env.OPENCODE_CONFIG_DIR) dirs.push(path.resolve(env.OPENCODE_CONFIG_DIR));
  for (const d of dirs) { readFile(path.join(d, 'opencode.json'), true); readFile(path.join(d, 'opencode.jsonc'), true); }
  if (env.OPENCODE_CONFIG) readFile(path.resolve(env.OPENCODE_CONFIG), true);
  // The project files OpenCode reads: from the working folder up to the git work tree root (the nearest folder with
  // .git), and no further. With no .git above, only the working folder.
  const dirsUp = [];
  let found = false;
  for (let dir = start; ;) {
    dirsUp.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) { found = true; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const dir of found ? dirsUp : [start]) {
    for (const f of ['opencode.json', 'opencode.jsonc', path.join('.opencode', 'opencode.json'), path.join('.opencode', 'opencode.jsonc')]) readFile(path.join(dir, f));
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { take(parseJsonc(String(env.OPENCODE_CONFIG_CONTENT)), false); } catch (_) { ok = false; }
  }
  return { servers, ok };
}

const OWN_CLI = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');

function realFile(p) {
  try {
    const r = fs.realpathSync.native(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch (_) {
    return null;
  }
}

/* Whether the command launches the bin/cli.js of the zn-gate package that runs this hook: the file the command names
 * (or the `zn` / `zn-gate` found on the absolute PATH entries) is the same file once links are resolved. A copy of
 * zn-gate elsewhere, or a path that only ends in /zn-gate/bin/cli.js, is not this package. */
function launchesThisPackage(command, root, env) {
  let words = command.map(String);
  if (words.length >= 4 && words[words.length - 2] === '--agent') words = words.slice(0, -2);
  const own = realFile(OWN_CLI);
  if (!own) return false;
  if (words.length === 3) return path.isAbsolute(words[1]) && !insideProject(root, words[1]) && realFile(words[1]) === own;
  if (words.length === 2) {
    const exe = require('../exe');
    const found = exe.whichSync(words[0], exe.absolutePath(env.PATH, process.platform, { cwd: root, env }));
    return Boolean(found) && realFile(found) === own;
  }
  return false;
}

/* True when every entry of the server is zn's own secrets server: defined in the user-level configuration (a project
 * file or OPENCODE_CONFIG_CONTENT can only be someone else's, and one of them with the same name overrides it), a local
 * command, never a URL, that launches this zn-gate package. */
function entriesAreOurs(entries, root, env = process.env) {
  const { isOurMcp } = require('../audit')._internal;
  return entries.length > 0 && entries.every(({ cfg, user }) => {
    if (!user || !cfg || typeof cfg !== 'object' || cfg.url || (cfg.type !== undefined && cfg.type !== 'local')) return false;
    if (!Array.isArray(cfg.command) || !cfg.command.length || !cfg.command.every((w) => typeof w === 'string')) return false;
    try { return Boolean(isOurMcp(cfg.command, { rec: { root } })) && launchesThisPackage(cfg.command, root, env); } catch (_) { return false; }
  });
}

/* ev.mcp for an OpenCode tool name: the configured server whose name is the longest prefix of it, and `ours: 'secrets'`
 * only when that server is zn's own and the rest of the name is exactly one of its tools. A name that matches no
 * configured server leaves the server unknown. Fails closed: an unreadable configuration means not ours. */
function mcpInfo(toolName, root, env = process.env) {
  const { isSecretsToolName } = require('../broker/secrets-tools');
  const info = { server: '', tool: toolName };
  let found;
  try { found = readMcpServers(root, env); } catch (_) { return info; }
  let best = null;
  for (const name of found.servers.keys()) {
    if (toolName.startsWith(name + '_') && (best === null || name.length > best.length)) best = name;
  }
  if (best === null) return info;
  info.server = best;
  info.tool = toolName.slice(best.length + 1);
  if (found.ok && isSecretsToolName(info.tool) && entriesAreOurs(found.servers.get(best), root, env)) info.ours = 'secrets';
  return info;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const args = raw.args && typeof raw.args === 'object' ? raw.args : {};
  const root = raw.cwd || process.cwd();
  // A command or file tool that names its own working directory is checked from there.
  const cwd = typeof args.workdir === 'string' && args.workdir ? path.resolve(root, args.workdir) : root;
  const base = { cwd, sessionId: raw.sessionID || null, raw };
  if (raw.hook === 'chat.message') return { ...base, event: 'user_prompt', tool: null, input: { prompt: typeof raw.prompt === 'string' ? raw.prompt : '' } };
  const t = String(raw.tool || '');
  let tool;
  if (t === 'read_mcp_resource') tool = 'mcpresource';
  else if (t === 'apply_patch' || t === 'patch') tool = 'write';
  // These return text the model reads, so their output is tokenized like MCP output.
  else if (TOKENIZED_OUTPUT.has(t)) tool = 'mcp';
  else if (BUILTIN.has(t)) tool = t;
  else tool = 'mcp';
  // OpenCode's bash tool runs in the user's shell. When the plugin saw that it is PowerShell,
  // the command is checked and wrapped as PowerShell, not as POSIX sh.
  if (tool === 'bash' && usesPowerShell(raw.shell, raw.platform)) tool = 'powershell';
  const input = {
    command: typeof args.command === 'string' ? args.command : undefined,
    path: args.filePath || args.path || undefined,
    url: typeof args.url === 'string' ? args.url : undefined,
    texts: textsOf(t === 'patch' ? 'apply_patch' : t, args),
  };
  if (t === 'apply_patch' || t === 'patch') {
    // Every file the patch touches is checked, as in the Codex adapter.
    const tooLong = String(args.patchText || '').length > PATCH_SCAN_CAP;
    const scan = tooLong ? { files: [], suspicious: false } : patchScan(args.patchText);
    const files = scan.files;
    input.paths = files;
    input.path = files[0];
    input.tooLong = tooLong;
    input.unparsed = !tooLong && (files.length === 0 || scan.suspicious);
  }
  if (raw.hook === 'tool.execute.before') {
    const ev = { ...base, event: 'pre_tool', tool, toolName: t, input };
    // MCP tools are checked before they run, as for Claude Code and Cursor. Of the built-ins whose output is tokenized
    // (TOKENIZED_OUTPUT), those that send their query out (OUTBOUND_QUERY) are checked too, as a call to a server that is
    // not zn's; the others (task, glob, list, skill) stay on the machine and are left alone.
    if (tool === 'mcp' && !TOKENIZED_OUTPUT.has(t)) {
      input.args = args;
      ev.mcp = mcpInfo(t, root);
    } else if (tool === 'mcp' && OUTBOUND_QUERY.has(t)) {
      input.args = args;
    }
    return ev;
  }
  if (raw.hook === 'tool.execute.after') {
    const output = {};
    if (typeof raw.output === 'string') output.output = raw.output;
    if (Array.isArray(raw.content)) output.content = raw.content;
    // metadata holds the TUI's copy of the output (previews, display text),
    // which OpenCode stores in its local database.
    if (raw.metadata && typeof raw.metadata === 'object') output.metadata = raw.metadata;
    // The runner only scrubs tools it knows; everything else counts as MCP.
    return { ...base, event: 'post_tool', tool: tool === 'write' || tool === 'edit' ? 'read' : tool, toolName: t, input, output };
  }
  return { ...base, event: null };
}

function respond(d) {
  const ev = d && d.event;
  if (!ev || !ev.event) return { action: 'none' };
  if (d.decision === 'deny' && ev.event !== 'post_tool') return { action: 'deny', message: d.message || 'Blocked by zn' };
  // OpenCode's plugin API has no question: one that zn wanted to ask is a deny.
  if (ev.event === 'pre_tool' && isPlainAsk(d)) return { action: 'deny', message: askAsDeny('OpenCode', d) };
  // Only rewrites that add no secret value (wrapping in `zn run`) are
  // applied. Restoring detected values into the arguments is not: OpenCode
  // keeps the mutated arguments in the session, where the model could read
  // them back. Those tokens stay as they are.
  if (ev.event === 'pre_tool' && d.updatedInput && d.kind === 'wrap') {
    const args = {};
    if (typeof d.updatedInput.command === 'string') args.command = d.updatedInput.command;
    for (const t of d.updatedInput.texts || []) args[t.key[0]] = t.value;
    return { action: 'args', args, message: d.message };
  }
  if (ev.event === 'post_tool' && d.updatedOutput !== undefined) {
    return { action: 'output', output: d.updatedOutput.output, content: d.updatedOutput.content, metadata: d.updatedOutput.metadata, message: d.message };
  }
  return { action: 'none' };
}

/* ------------------------------ plugin ------------------------------ */

// Seconds the plugin waits for the runner before it gives up (and the post-tool check stops before that).
const HOOK_TIMEOUT_S = 20;

function pluginSource(opts = {}) {
  // A project plugin is shared through the repository: it calls `zn` on PATH
  // instead of naming this user's node and runner.
  const project = (opts.scope || 'user') === 'project';
  const node = JSON.stringify((opts.nodePath || process.execPath).replace(/\\/g, '/'));
  const runner = JSON.stringify((opts.runnerPath || cfg.runnerPath()).replace(/\\/g, '/'));
  const launch = project ? 'const NODE = "zn";\nconst RUNNER = null;' : `const NODE = ${node};\nconst RUNNER = ${runner};`;
  const argv = project ? '["hook", "opencode"]' : '[RUNNER, "opencode"]';
  // The repair step a blocked call names: check what is wrong, then install the hook again (the same scope).
  const repair = JSON.stringify('Run ' + cliName('zn-gate') + ' check in a terminal, then ' + cliName('zn') + ' hooks install opencode' + (project ? ' --project' : '') + '.');
  // On Windows `zn` is zn.cmd, which spawn runs only through a shell. The
  // arguments are fixed strings, so the shell adds no input of its own; and
  // neither `zn` nor the `node` it starts may come from the folder OpenCode
  // runs in (the project, where an agent can write a zn or node of its own):
  // the PATH keeps only its absolute entries, and cmd.exe does not look in the
  // current directory first.
  const shell = project ? 'process.platform === "win32"' : 'false';
  const env = project ? 'hookEnv(projectEnv())' : 'hookEnv(process.env)';
  const projectEnvSource = project ? `
// The environment of \`zn\`: the PATH without its relative or empty entries, and
// on Windows no search of the current directory by cmd.exe.
function projectEnv() {
  const win = process.platform === "win32";
  const env = {};
  let pathValue = "";
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === "PATH") pathValue = String(v || "");
    else env[k] = v;
  }
  // A PATH entry, or the zn or node in it, can be a link into node_modules/.bin or into the project: the real paths count too.
  // An entry whose real folder cannot be read, or that is in a node_modules folder or in the project, is dropped; so is an
  // entry whose zn or node really is in a node_modules/.bin folder or in the project. The project is the folder OpenCode
  // runs in, unless that is / or the home folder. (A global npm install links zn into <prefix>/node_modules/zn-gate: kept.)
  const real = (p) => { try { return realpathSync(p).split("\\\\").join("/").toLowerCase(); } catch (_) { return null; } };
  const here = real(process.cwd());
  const home = real(homedir());
  const inProject = (p) => !!here && here !== home && here.length > 3 && (p === here || p.startsWith(here + "/"));
  const names = win ? ["zn.cmd", "zn.exe", "zn", "node.exe", "node.cmd"] : ["zn", "node"];
  const sep = win ? ";" : ":";
  const keep = (d) => {
    if (!(win ? /^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)/.test(d) : d.startsWith("/")) || /node_modules/i.test(d)) return false;
    const rd = real(d);
    if (!rd || rd.includes("/node_modules/") || rd.endsWith("/node_modules") || inProject(rd)) return false;
    for (const n of names) {
      const f = d + (win ? "/" : "/") + n;
      if (!existsSync(f)) continue;
      const rf = real(f);
      if (!rf || rf.includes("/node_modules/.bin/") || inProject(rf)) return false;
    }
    return true;
  };
  env.PATH = pathValue.split(win ? ";" : ":").filter(keep).join(win ? ";" : ":");
  if (win) env.NoDefaultCurrentDirectoryInExePath = "1";
  return env;
}
` : '';
  return `${PLUGIN_MARK} (written by \`zn hooks install opencode\`; remove with \`zn hooks uninstall opencode\`).
// Sends tool calls, tool results and chat messages to the local zn hook runner,
// which blocks reads of secret files, puts commands that use stored secrets
// through \`zn run\`, and replaces secret values in tool output with __ZN_ tokens.
import { spawn } from "node:child_process";
${project ? 'import { existsSync, realpathSync } from "node:fs";\nimport { homedir } from "node:os";\n' : ''}
${launch}
${projectEnvSource}
// Variables that make Node.js or the dynamic loader load code of the caller's choosing (NODE_OPTIONS=--require, LD_PRELOAD
// and the like) are not passed to the hook: a project can set the environment of OpenCode, and such code would run inside
// the hook itself. NODE_EXTRA_CA_CERTS and the proxy settings are passed.
const LOADER_VAR = new RegExp(${JSON.stringify(LOADER_SOURCE)}, "i");
function hookEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!LOADER_VAR.test(k)) env[k] = v;
  return env;
}
const TIMEOUT_MS = ${HOOK_TIMEOUT_S * 1000};
// The only answers the plugin acts on. Any other answer is an error, which
// blocks the call (before), withholds the output (after) or stops the message.
const ACTIONS = ["none", "deny", "error", "args", "output"];
// OpenCode runs its bash tool in $SHELL, or in PowerShell on Windows when it is unset. The
// runner needs only the program's name (not its path) and the platform to tell them apart.
const SHELL = String(process.env.SHELL || "").replace(/\\\\/g, "/").split("/").pop();

// Why the hook could not answer, in plain words: a spawn error names the missing program, not a raw ENOENT.
const REPAIR = ${repair};
function why(m) {
  if (/ENOENT/.test(m)) return NODE === "zn" ? "zn was not found on the PATH" : "the Node.js it was installed with was not found";
  if (/EACCES|EPERM/.test(m)) return "the hook could not be started (permission denied)";
  return m;
}

// Copy scrubbed string leaves from src into target, in place.
function applyStrings(target, src) {
  if (!target || !src || typeof target !== "object" || typeof src !== "object") return;
  for (const k of Object.keys(src)) {
    if (typeof src[k] === "string" && typeof target[k] === "string") target[k] = src[k];
    else if (src[k] && typeof src[k] === "object") applyStrings(target[k], src[k]);
  }
}

function runHook(event) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(NODE, ${argv}, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: ${shell}, env: ${env} });
    } catch (err) {
      finish({ action: "error", message: String(err && err.message || err) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ action: "error", message: "timeout" }); }, TIMEOUT_MS);
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", (err) => { clearTimeout(timer); finish({ action: "error", message: String(err && err.message || err) }); });
    child.on("close", () => {
      clearTimeout(timer);
      let answer = null;
      try { answer = JSON.parse(out); } catch (_) { answer = null; }
      if (!answer || typeof answer !== "object" || !ACTIONS.includes(answer.action)) {
        finish({ action: "error", message: "no answer from the zn hook" });
      } else {
        finish(answer);
      }
    });
    // A hook that ends without reading its input (EPIPE) is answered by close above; it must not crash OpenCode.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

export const ZnGate = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    const r = await runHook({ hook: "tool.execute.before", tool: input.tool, sessionID: input.sessionID, cwd: directory, args: output.args, shell: SHELL, platform: process.platform });
    if (r.action === "deny") throw new Error(r.message);
    if (r.action === "error") throw new Error("zn: the secret scrubber is not working (" + why(r.message) + "), so this call was blocked. " + REPAIR);
    if (r.action === "args" && r.args) for (const [k, v] of Object.entries(r.args)) output.args[k] = v;
  },
  "tool.execute.after": async (input, output) => {
    const content = Array.isArray(output.content) ? output.content : null;
    const r = await runHook({
      hook: "tool.execute.after", tool: input.tool, sessionID: input.sessionID, cwd: directory, args: input.args, shell: SHELL, platform: process.platform,
      output: typeof output.output === "string" ? output.output : undefined,
      metadata: output.metadata && typeof output.metadata === "object" ? output.metadata : undefined,
      content: content ? content.map((c) => (c && typeof c.text === "string" ? { type: c.type, text: c.text } : { type: c && c.type })) : undefined,
    });
    if (r.action === "error") {
      if (typeof output.output === "string") output.output = "[zn: output withheld: the secret scrubber is not working]";
      if (output.metadata && typeof output.metadata === "object") output.metadata = {};
      if (content) for (const c of content) if (c && typeof c.text === "string") c.text = "[zn: output withheld]";
      return;
    }
    if (r.action !== "output") return;
    if (typeof r.output === "string" && typeof output.output === "string") output.output = r.output;
    if (r.metadata) applyStrings(output.metadata, r.metadata);
    if (content && Array.isArray(r.content)) r.content.forEach((c, i) => { if (c && typeof c.text === "string" && content[i]) content[i].text = c.text; });
  },
  "chat.message": async (input, output) => {
    const parts = Array.isArray(output.parts) ? output.parts : [];
    const prompt = parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\\n");
    if (!prompt) return;
    const r = await runHook({ hook: "chat.message", sessionID: input.sessionID, cwd: directory, prompt });
    if (r.action === "deny") throw new Error(r.message);
    if (r.action === "error") throw new Error("zn: the secret scrubber is not working (" + why(r.message) + "), so this message was not sent. " + REPAIR);
  },
});
`;
}

/* ------------------------ install / uninstall ---------------------- */

function configDir(opts = {}) {
  const env = opts.env || process.env;
  return path.join(env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(opts.home || os.homedir(), '.config'), 'opencode');
}

function pluginPath(opts = {}) {
  if ((opts.scope || 'user') === 'project') return path.join(path.resolve(opts.projectDir || process.cwd()), '.opencode', 'plugins', PLUGIN_FILE);
  return path.join(configDir(opts), 'plugins', PLUGIN_FILE);
}

/** True when the file is a plugin that zn wrote (a regular file that starts with zn's mark). */
function isOurs(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    return fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARK);
  } catch (_) { return false; }
}

function install(opts = {}) {
  const file = pluginPath(opts);
  const report = { settings: file, backup: null, warnings: [] };
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARK)) {
    throw new Error(file + ' exists and was not written by zn; left unchanged');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, pluginSource(opts), 0o644);
  if (opts.mcp !== false) {
    // A project's opencode.json is shared: the hint names zn on the PATH, never the paths of this machine.
    const project = (opts.scope || 'user') === 'project';
    const cli = path.resolve(__dirname, '..', '..', 'bin', 'cli.js').replace(/\\/g, '/');
    const command = project
      ? ['zn', 'secrets-mcp', '--agent', 'opencode']
      : [(opts.nodePath || process.execPath).replace(/\\/g, '/'), cli, 'secrets-mcp', '--agent', 'opencode'];
    report.warnings.push('optional: to let OpenCode use the secrets kept in zn\'s vault, add the "secrets" MCP server to ' +
      (project ? 'your own opencode.json, ~/.config/opencode/opencode.json (zn does not trust a "secrets" server that a project defines)' : 'opencode.json') +
      ' under "mcp": "secrets": ' + JSON.stringify({ type: 'local', command }));
  }
  return report;
}

function uninstall(opts = {}) {
  const file = pluginPath(opts);
  const report = { settings: file, backup: null, removed: 0, warnings: [] };
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARK)) {
    fs.unlinkSync(file);
    report.removed = 1;
  }
  return report;
}

function detect(opts = {}) {
  if (whichSync('opencode', (opts.env || process.env).PATH || '')) return true;
  return fs.existsSync(configDir(opts));
}

module.exports = {
  id,
  HOOK_TIMEOUT_S,
  detect,
  install,
  uninstall,
  normalize,
  isPowerShellName,
  usesPowerShell,
  respond,
  capabilities: { ask: false, rewriteInput: true, rewriteOutput: 'all' },
  pluginSource,
  pluginPath,
  isOurs,
};
