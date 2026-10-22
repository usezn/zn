'use strict';

/**
 * Small helpers shared by the agent adapters to edit their JSON config
 * files: read (missing file = {}), timestamped backup, atomic write, and
 * removal of only the hook entries zn wrote.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../broker/files');
const { shQuote, portablePath, windowsCommand, windowsCommandScript } = require('../shell-quote');

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('cannot parse ' + file + ': ' + err.message + ' (left unchanged)');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(file + ' must hold a JSON object, not ' + (data === null ? 'null' : Array.isArray(data) ? 'an array' : typeof data) + ' (left unchanged)');
  }
  return data;
}

/** The "hooks" object of a config file: missing or null is empty; anything else must be an object. */
function hooksOf(data, file) {
  if (data.hooks === undefined || data.hooks === null) return {};
  if (typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw new Error('"hooks" in ' + file + ' must be an object, not ' + (Array.isArray(data.hooks) ? 'an array' : typeof data.hooks) + ' (left unchanged)');
  }
  return data.hooks;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const dest = file + '.bak-zn-' + stamp;
  fs.copyFileSync(file, dest);
  return dest;
}

/** Where the config really lives: an existing symlink is followed, so the link itself stays as it is. */
function realFile(file) {
  try { return fs.realpathSync(file); } catch (_) { return file; }
}

/**
 * A project install writes into a folder a repository controls. Refuse a config
 * file that is a symlink (dangling or not), and a file or folder whose real
 * location is outside the project, so a repository cannot make zn write
 * anywhere else. User scope is left as it is (dotfiles managers use symlinks).
 */
function assertInsideProject(file, opts = {}) {
  if ((opts.scope || 'user') !== 'project') return;
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const refuse = (why) => new Error('Refusing to write ' + file + ': ' + why + '. Nothing was changed.');
  let root;
  try { root = fs.realpathSync(projectDir); } catch (_) { throw refuse('the project folder cannot be resolved'); }
  const inside = (p) => {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw refuse('it is a symbolic link');
  } catch (err) {
    if (err.code !== 'ENOENT') { if (/^Refusing/.test(err.message)) throw err; throw refuse('it cannot be inspected (' + err.code + ')'); }
  }
  // The nearest existing folder above the file (a missing one is created later, inside it).
  let cur = path.dirname(file);
  for (;;) {
    let exists = true;
    try { fs.lstatSync(cur); } catch (err) { if (err.code === 'ENOENT') exists = false; else throw refuse('its folder cannot be inspected (' + err.code + ')'); }
    if (exists) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let real;
  try { real = fs.realpathSync(cur); } catch (_) { throw refuse('its folder is a broken symbolic link'); }
  if (!inside(real)) throw refuse('its folder resolves outside the project');
  try {
    if (!inside(fs.realpathSync(file))) throw refuse('it resolves outside the project');
  } catch (err) {
    if (/^Refusing/.test(err.message)) throw err;
    /* missing file: nothing to resolve */
  }
}

function writeJson(file, data) {
  const target = realFile(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
  writeFileAtomic(target, JSON.stringify(data, null, 2) + '\n', mode);
}

/** A path as one sh word (single quotes; see lib/shell-quote.js). */
function quoteArg(s, platform = process.platform) {
  return shQuote(portablePath(s, platform));
}

function runnerPath() {
  return path.resolve(__dirname, '..', 'hooks', 'runner.js');
}

/**
 * The command an agent runs for each hook event. A user install names this
 * user's node and runner. A project install is shared through the repository,
 * so it names `zn` on PATH instead of any path of this user.
 */
function hookCommand(agentId, opts = {}) {
  if (opts.command) return opts.command;
  if ((opts.scope || 'user') === 'project') return 'zn hook ' + agentId;
  const platform = opts.platform || process.platform;
  return quoteArg(opts.nodePath || process.execPath, platform) + ' ' + quoteArg(opts.runnerPath || runnerPath(), platform) + ' ' + agentId;
}

/**
 * The same command for a Windows shell that may be cmd.exe or PowerShell:
 * Codex runs `commandWindows` through %COMSPEC% /C (cmd.exe), and Cursor wraps
 * hook commands in PowerShell. It calls powershell.exe with PowerShell-quoted
 * paths, written so that neither cmd.exe nor an outer PowerShell or Git Bash
 * expands anything in them (see windowsCommand in lib/shell-quote.js).
 */
function hookCommandWindows(agentId, opts = {}) {
  if ((opts.scope || 'user') === 'project') return 'zn hook ' + agentId;
  return windowsCommand(opts.nodePath || process.execPath, [opts.runnerPath || runnerPath()], [agentId], { encoded: opts.encodedCommand === true });
}

/**
 * Whether a hook command is one zn wrote for this agent: `zn hook <agent>`,
 * the runner called with double quotes (older versions) or single quotes,
 * or the Windows powershell.exe form.
 */
function isOurs(command, agentId) {
  if (typeof command !== 'string') return false;
  // zn's launcher script (lib/agents/launcher.js): '<dir>/zn-hook-<agent>.sh' <Event>
  if (new RegExp("zn-hook-" + agentId + "\\.sh'? [A-Za-z]+\\s*$").test(command)) return true;
  const re = new RegExp('(\\bhook ' + agentId + '|hooks[\\\\/]runner\\.js["\']? ' + agentId + ')\\s*$');
  if (re.test(command)) return true;
  const script = windowsCommandScript(command);
  return script !== null && re.test(script);
}

module.exports = { assertInsideProject, readJson, hooksOf, backup, writeJson, quoteArg, runnerPath, hookCommand, hookCommandWindows, isOurs };
