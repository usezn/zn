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
const { configParseError } = require('../config-parse');

/**
 * How a JSON file was written, so it can be written back the same way:
 * { eol: '\n' | '\r\n', indent: number of spaces | '\t', bom: boolean, trailingNewline: boolean }.
 * A file that does not exist (or is blank) gets zn's usual format: LF, two spaces, a final newline.
 */
const DEFAULT_STYLE = Object.freeze({ eol: '\n', indent: 2, bom: false, trailingNewline: true });

function detectStyle(text) {
  const bom = text.charCodeAt(0) === 0xFEFF;
  const body = bom ? text.slice(1) : text;
  const style = { ...DEFAULT_STYLE, bom };
  const nl = body.indexOf('\n');
  if (nl < 0) return style; // one line (minified): written out the usual way
  style.eol = body[nl - 1] === '\r' ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(body);
  if (m) style.indent = m[1][0] === '\t' ? '\t' : Math.min(m[1].length, 10);
  style.trailingNewline = /\n$/.test(body);
  return style;
}

/** JSON text for data in the given style (default: LF, two spaces, final newline). */
function formatJson(data, style = DEFAULT_STYLE) {
  let out = JSON.stringify(data, null, style.indent);
  if (style.eol !== '\n') out = out.replace(/\n/g, style.eol);
  if (style.trailingNewline) out += style.eol;
  return (style.bom ? '\uFEFF' : '') + out;
}

// The style each parsed object was read in; writeJson and stringifyJson look it up, so callers keep passing plain data.
const STYLES = new WeakMap();

/** Parses JSON text (a leading BOM is allowed) and remembers its style for the data object. Throws SyntaxError. */
function parseJson(text) {
  const style = detectStyle(text);
  const data = JSON.parse(style.bom ? text.slice(1) : text);
  if (data !== null && typeof data === 'object') STYLES.set(data, style);
  return data;
}

/** JSON text for data, in the style it was read in (see parseJson) or the default one. */
function stringifyJson(data) {
  return formatJson(data, STYLES.get(data) || DEFAULT_STYLE);
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!text.replace(/^\uFEFF/, '').trim()) return {};
  let data;
  try {
    data = parseJson(text);
  } catch (err) {
    throw new Error(configParseError(file, text, err));
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

/** How many zn backups of one config file are kept (the newest ones); older ones are removed on each new backup. */
const KEEP_BACKUPS = 3;
const ABSENT_SUFFIX = '-absent';
// The file as it was before the first install is kept apart from the rotating backups and never pruned:
// '<file>.bak-zn-original' (a copy) or '<file>.bak-zn-original-absent' (an empty marker: install created the file).
const ORIGINAL_SUFFIX = '.bak-zn-original';
const ABSENT = Object.freeze({ absent: true });

/** A new backup name next to the file, never an existing one (two backups in the same second get -2, -3...). */
function newBackupPath(file, absent) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const tail = absent ? ABSENT_SUFFIX : '';
  let dest = file + '.bak-zn-' + stamp + tail;
  for (let n = 2; fs.existsSync(dest); n++) dest = file + '.bak-zn-' + stamp + '-' + n + tail;
  return dest;
}

/**
 * The zn backups of a file, newest first: [{ path, absent }]. A backup with the -absent suffix is an empty marker that
 * records that the file did not exist before install.
 */
function backupsOf(file) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.bak-zn-';
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || name === path.basename(file) + ORIGINAL_SUFFIX || name === path.basename(file) + ORIGINAL_SUFFIX + ABSENT_SUFFIX) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isFile()) out.push({ path: p, absent: name.endsWith(ABSENT_SUFFIX), mtime: st.mtimeMs });
  }
  out.sort((a, b) => (b.mtime - a.mtime) || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
  return out;
}

/** Keeps the KEEP_BACKUPS newest zn backups of a file and removes the rest. */
function pruneBackups(file, keep = KEEP_BACKUPS) {
  for (const b of backupsOf(file).slice(keep)) {
    try { fs.unlinkSync(b.path); } catch (_) { /* already gone */ }
  }
}

function removeOriginals(file) {
  for (const p of [file + ORIGINAL_SUFFIX, file + ORIGINAL_SUFFIX + ABSENT_SUFFIX]) {
    try { fs.unlinkSync(p); } catch (_) { /* not there */ }
  }
}

/**
 * Copies the file before zn changes it and returns the copy's path, or null when the file did not exist (an empty marker
 * is written instead, so uninstall knows install created the file). Only the newest KEEP_BACKUPS copies are kept.
 * Besides those, the first install also keeps the file as it was (or the marker) apart; it is never pruned and later
 * installs do not overwrite it. opts.original = false (uninstall) leaves it alone.
 */
function backup(file, opts = {}) {
  const keepOriginal = opts.original !== false;
  const hasOriginal = fs.existsSync(file + ORIGINAL_SUFFIX) || fs.existsSync(file + ORIGINAL_SUFFIX + ABSENT_SUFFIX);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(newBackupPath(file, true), '');
    if (keepOriginal) {
      // The file is gone now (removed by hand after an earlier install): an older original no longer applies.
      removeOriginals(file);
      fs.writeFileSync(file + ORIGINAL_SUFFIX + ABSENT_SUFFIX, '');
    }
    pruneBackups(file);
    return null;
  }
  const dest = newBackupPath(file, false);
  fs.copyFileSync(file, dest);
  if (keepOriginal && !hasOriginal) fs.copyFileSync(file, file + ORIGINAL_SUFFIX);
  pruneBackups(file);
  return dest;
}

/**
 * Undoes backup(file) after a failed write: removes the copy it returned and, when no other rotating backup is left
 * (this was the first install), the kept original it may have created too.
 */
function discardBackup(file, copy) {
  if (copy) { try { fs.unlinkSync(copy); } catch (_) { /* none */ } }
  if (backupsOf(file).length === 0) removeOriginals(file);
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Wraps a strip(data) helper that may tidy up data it did not change: the wrapper changes data only when strip reports
 * that it removed something, which uninstallJson relies on.
 */
function ifChanged(strip) {
  return (data) => {
    if (!strip(JSON.parse(JSON.stringify(data)))) return false;
    strip(data);
    return true;
  };
}

/** The keys install adds to a file that had none: "version": 1 and an empty "hooks" object. */
function isInstallLeftover(data) {
  return Object.keys(data).every((k) => (k === 'version' && data.version === 1) || (k === 'hooks' && isPlainObject(data.hooks) && Object.keys(data.hooks).length === 0));
}

/**
 * The file as it was before zn's install: the newest zn backup that holds no zn entry (removeOurs reports none), or
 * ABSENT when install created the file, or undefined when no such backup is left.
 */
function originalOf(file, removeOurs) {
  const fromCopy = (p) => {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return undefined; }
    let data;
    try { data = text.replace(/^\uFEFF/, '').trim() ? parseJson(text) : {}; } catch (_) { return undefined; }
    if (!isPlainObject(data) || removeOurs(data)) return undefined;
    return { data, text };
  };
  // The copy kept by the first install comes first; a copy that already holds zn entries (taken after an install by an
  // older version) is not an original and is skipped.
  if (fs.existsSync(file + ORIGINAL_SUFFIX + ABSENT_SUFFIX)) return ABSENT;
  const kept = fromCopy(file + ORIGINAL_SUFFIX);
  if (kept) return kept;
  // Configs installed by an older version have no such copy: use the newest rotating backup that is still an original.
  for (const b of backupsOf(file)) {
    if (b.absent) return ABSENT;
    const o = fromCopy(b.path);
    if (o) return o;
  }
  return undefined;
}

/** True when the data, minus the keys install adds to a file that had none, equals the original. */
function sameAsOriginal(data, original) {
  const d = { ...data };
  if (!('version' in original) && d.version === 1) delete d.version;
  if (!('hooks' in original) && isPlainObject(d.hooks) && Object.keys(d.hooks).length === 0) delete d.hooks;
  return canonical(d) === canonical(original);
}

/**
 * Uninstall for a JSON config zn edits. removeOurs(data) takes zn's entries out of data in place and returns true when it
 * removed any (and changes nothing when it removed none). Then:
 * - install created the file and only zn's keys are left: the file is deleted;
 * - the file is as install left it (no other key changed) and the original is known: the original bytes come back,
 *   so a one-line file, a pre-existing "{}" and the indentation are kept as they were;
 * - anything else: zn's entries are removed and the rest is written back as it was.
 * The original comes from the copy the first install kept (never pruned); a config installed by an older version has
 * none, so the newest rotating backup that is still an original is used, if any is left. Without any original,
 * opts.leftover(data), when given, says whether what is left is only what install adds, and the file is deleted.
 * Returns { action: 'unchanged' | 'deleted' | 'restored' | 'written', backup }.
 */
function uninstallJson(file, removeOurs, read = readJson, opts = {}) {
  if (!fs.existsSync(file)) return { action: 'unchanged', backup: null };
  const data = read(file);
  if (!removeOurs(data)) return { action: 'unchanged', backup: null };
  const original = originalOf(file, removeOurs);
  const copy = backup(file, { original: false });
  const leftover = typeof opts.leftover === 'function' && opts.leftover(data);
  let action;
  if ((original === ABSENT && isInstallLeftover(data)) || ((original === undefined || original === ABSENT) && leftover)) {
    fs.unlinkSync(file);
    action = 'deleted';
  } else if (original && original !== ABSENT && sameAsOriginal(data, original.data)) {
    const target = realFile(file);
    const mode = fs.statSync(target).mode & 0o777;
    writeFileAtomic(target, original.text, mode);
    action = 'restored';
  } else {
    writeJson(file, data);
    action = 'written';
  }
  removeOriginals(file); // zn is out of the file: the next install starts a new original
  return { action, backup: copy };
}

/** Where the config really lives: an existing symlink is followed, so the link itself stays as it is. */
function realFile(file) {
  try { return fs.realpathSync(file); } catch (_) { return file; }
}

function writeJson(file, data) {
  const target = realFile(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
  writeFileAtomic(target, stringifyJson(data), mode);
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
  // The project hook with its own start guard (lib/agents/launcher.js projectShCommand).
  if (require('./launcher').isProjectGuard(command, agentId)) return true;
  const re = new RegExp('(\\bhook ' + agentId + '|hooks[\\\\/]runner\\.js["\']? ' + agentId + ')\\s*$');
  if (re.test(command)) return true;
  const script = windowsCommandScript(command);
  return script !== null && re.test(script);
}

module.exports = { readJson, parseJson, stringifyJson, formatJson, detectStyle, hooksOf, backup, backupsOf, pruneBackups, discardBackup, removeOriginals, uninstallJson, ifChanged, writeJson, quoteArg, runnerPath, hookCommand, hookCommandWindows, isOurs, KEEP_BACKUPS };
