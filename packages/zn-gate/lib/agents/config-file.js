'use strict';

/**
 * Small helpers shared by the agent adapters to edit their JSON config
 * files: read (missing file = {}), backup, safe read-edit-write (updateJson), and
 * removal of only the hook entries zn wrote.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const launcher = require('./launcher');
const { shQuote, portablePath, windowsCommand, windowsCommandScript } = require('../shell-quote');

/** Parses the text of a JSON config file: blank is {}, anything but an object is refused. */
function parseJson(text, file) {
  if (text === null || !text.trim()) return {};
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

const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);

/** A permission error as a sentence that says what to fix; any other error is passed on as it is. */
function explain(err, what, file) {
  if (err && DENIED.has(err.code)) {
    const e = new Error('cannot ' + what + ' ' + file + ': permission denied (' + err.code + '). Fix the permissions of that file or its folder and run this again (left unchanged)');
    e.code = err.code;
    return e;
  }
  return err;
}

/** The file's text, or null when it does not exist. A leading BOM is kept (see updateJson). */
function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw explain(err, 'read', file);
  }
}

function readJson(file) {
  const raw = readRaw(file);
  return parseJson(raw === null ? null : raw.replace(/^﻿/, ''), file);
}

/** The "hooks" object of a config file: missing or null is empty; anything else must be an object. */
function hooksOf(data, file) {
  if (data.hooks === undefined || data.hooks === null) return {};
  if (typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw new Error('"hooks" in ' + file + ' must be an object, not ' + (Array.isArray(data.hooks) ? 'an array' : typeof data.hooks) + ' (left unchanged)');
  }
  return data.hooks;
}

/** The events zn is about to write must each hold a list (or be absent): a value of another type is the user's, never replaced. */
function assertEventLists(hooks, events, file) {
  for (const event of events) {
    const v = hooks[event];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error('"hooks.' + event + '" in ' + file + ' must be a list, not ' + (v === null ? 'null' : typeof v === 'object' ? 'an object' : typeof v) + ' (left unchanged)');
    }
  }
}

/* ------------------------------- backups ------------------------------- */

// Backups of one file: the original (the oldest, from before zn first touched it) is always kept, plus the newest few.
const KEEP_BACKUPS = 5;
const BACKUP_MARK = '.bak-zn-';

/** [stamp, counter] of a backup name, to put them in the order they were made. */
function backupOrder(name) {
  const m = /\.bak-zn-(\d{8}T\d{6})(?:-(\d+))?$/.exec(name);
  return m ? [m[1], Number(m[2] || 0)] : null;
}

function backupsOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + BACKUP_MARK;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter((n) => n.startsWith(base) && backupOrder(n))
    .sort((a, b) => {
      const x = backupOrder(a);
      const y = backupOrder(b);
      return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1];
    })
    .map((n) => path.join(dir, n));
}

/**
 * Copies the file next to itself as <file>.bak-zn-<time>[-n] and returns the copy (null when there is no file).
 * An existing backup is never overwritten: a second backup in the same second gets a counter, and when a backup
 * with exactly this content already exists it is reused instead of making another. After that only the original
 * (the oldest) and the newest KEEP_BACKUPS stay.
 */
function backup(file) {
  const src = realFile(file);
  let content;
  try { content = fs.readFileSync(src); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw explain(err, 'read', src);
  }
  for (const b of backupsOf(src).reverse()) {
    try { if (fs.readFileSync(b).equals(content)) return b; } catch (_) { /* unreadable: not a match */ }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  // The counter goes above every backup of this second, also one that was pruned, so the order stays the order they were made in.
  let first = 0;
  for (const b of backupsOf(src)) {
    const o = backupOrder(b);
    if (o[0] === stamp && o[1] >= first) first = o[1] + 1;
  }
  let dest;
  for (let n = first; ; n++) {
    dest = src + BACKUP_MARK + stamp + (n ? '-' + n : '');
    try {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      break;
    } catch (err) {
      if (err.code === 'EEXIST' && n < first + 1000) continue;
      throw explain(err, 'write a backup of', src);
    }
  }
  const all = backupsOf(src);
  for (const old of all.slice(1, Math.max(1, all.length - KEEP_BACKUPS))) {
    if (old !== dest) { try { fs.unlinkSync(old); } catch (_) { /* best effort */ } }
  }
  return dest;
}

/**
 * Where the config really lives: an existing symlink is followed (also a dangling one), so the link itself
 * stays as it is and the backup and the new content go next to the file it points at.
 */
function realFile(file) {
  try { return fs.realpathSync(file); } catch (_) { /* missing or dangling */ }
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return path.resolve(path.dirname(file), fs.readlinkSync(file));
  } catch (_) { /* not a link */ }
  return file;
}

/** Writes through a temporary file in the same folder, with the given mode (not changed by the umask). */
function writeAtomic(target, text, mode) {
  const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.zn-tmp');
  try {
    fs.writeFileSync(tmp, text, { mode });
    try { fs.chmodSync(tmp, mode); } catch (_) { /* best effort */ }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* none */ }
    throw explain(err, 'write', target);
  }
}

/** The indentation, line ending and final newline the file already uses, so an edit does not reformat it. */
function styleOf(text) {
  if (text === null || !text.trim()) return { indent: 2, eol: '\n', final: '\n' };
  const m = /\n([ \t]+)\S/.exec(text);
  let indent = 2;
  if (m) indent = m[1][0] === '\t' ? '\t' : (/^ +$/.test(m[1]) && m[1].length <= 8 ? m[1].length : 2);
  return { indent, eol: /\r\n/.test(text) ? '\r\n' : '\n', final: /\n\s*$/.test(text) ? (/\r\n$/.test(text) ? '\r\n' : '\n') : '' };
}

function render(data, style, bom) {
  let out = JSON.stringify(data, null, style.indent);
  if (style.eol !== '\n') out = out.replace(/\n/g, style.eol);
  return (bom ? '﻿' : '') + out + style.final;
}

// How many times a read-edit-write starts over when another program changed the file in the meantime.
const ATTEMPTS = 5;
// Returned by an edit to delete the file (e.g. nothing left in it) instead of writing it.
const REMOVE_FILE = Symbol('remove-file');

/**
 * Reads a JSON config file, lets edit(data) change it, and writes the result back safely:
 *  - edit may throw to refuse (a malformed file): nothing has been written or backed up by then;
 *  - edit returns false when it changed nothing; and when the new content equals the old, nothing is
 *    written and no backup is made;
 *  - the file is read again just before the write; if another program changed it, the edit starts over on
 *    the new content (ATTEMPTS times), and then fails with the file untouched, so no key is lost;
 *  - the mode of the existing file is kept, and a file the owner cannot write to is refused, not replaced;
 *  - indentation, line ending, final newline and a BOM are kept; a symlink is written through;
 *  - the previous content is saved by backup() first.
 * opts.create === false: a missing file is not created (returns {changed: false}).
 * Returns {changed, backup, removed}. `edit` can run more than once: keep it free of side effects that matter.
 */
function updateJson(file, edit, opts = {}) {
  const target = realFile(file);
  const nothing = { changed: false, backup: null, removed: false };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const raw = readRaw(target);
    if (raw === null && opts.create === false) return nothing;
    const bom = raw !== null && raw.charCodeAt(0) === 0xFEFF;
    const text = raw === null ? null : (bom ? raw.slice(1) : raw);
    const data = parseJson(text, file);
    const before = JSON.stringify(data);
    const result = edit(data);
    const blank = text === null || !text.trim();
    const remove = result === REMOVE_FILE;
    if (!remove && (result === false || (!blank && JSON.stringify(data) === before))) return nothing;
    if (remove && raw === null) return nothing;
    if (readRaw(target) !== raw) continue;
    let mode = 0o644;
    if (raw !== null) {
      try { mode = fs.statSync(target).mode & 0o777; } catch (err) { throw explain(err, 'read', target); }
      if ((mode & 0o200) === 0) {
        throw new Error(target + ' is read-only, so zn did not change it. Make it writable (for example chmod u+w) and run this again (left unchanged)');
      }
    }
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (err) { throw explain(err, 'create the folder of', target); }
    const saved = raw === null ? null : backup(target);
    if (readRaw(target) !== raw) continue;
    if (remove) {
      try { fs.unlinkSync(file); } catch (err) { throw explain(err, 'remove', file); }
      return { changed: true, backup: saved, removed: true };
    }
    writeAtomic(target, render(data, styleOf(text), bom), mode);
    return { changed: true, backup: saved, removed: false };
  }
  throw new Error('cannot update ' + file + ': it kept changing while zn was writing it (another program is editing it). Run this again (left unchanged)');
}

/** Writes a JSON config file whole (keeps the mode of an existing one, follows a symlink). Prefer updateJson. */
function writeJson(file, data) {
  const target = realFile(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
  writeAtomic(target, JSON.stringify(data, null, 2) + '\n', mode);
}

/**
 * Runs fn (an install that may write zn's launcher script); when it throws, a launcher this call created is
 * removed again, so a refused install leaves nothing behind in ~/.zn/hooks.
 */
function withLauncherCleanup(agentId, opts, fn) {
  const file = launcher.launcherFile(agentId, opts);
  const existed = fs.existsSync(file);
  try {
    return fn();
  } catch (err) {
    if (!existed) { try { fs.unlinkSync(file); } catch (_) { /* none */ } }
    throw err;
  }
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

module.exports = { readJson, hooksOf, assertEventLists, backup, writeJson, updateJson, withLauncherCleanup, REMOVE_FILE, KEEP_BACKUPS, quoteArg, runnerPath, hookCommand, hookCommandWindows, isOurs };
