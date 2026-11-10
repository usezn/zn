'use strict';
/**
 * `zn audit --pre-open`: static checks of a cloned folder for things that can
 * run before an agent shows its trust prompt. Nothing here starts a program,
 * and no `git` subprocess is used (git would read the very config under
 * review). Values are read to classify them and are never reported: a finding
 * carries the rule id, the file, the line and the config key name only.
 *
 *   ZNA024  a git config that makes git run a program or load a file from the tree
 *   ZNA025  a bare repository nested in the working tree
 *   ZNA026  an executable named like a common tool in a folder that is often on PATH
 *
 * Symbolic links are never followed out of the tree.
 */

const fs = require('fs');
const path = require('path');

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 50000;
const MAX_WALK_DEPTH = 32;
const MAX_FINDINGS_PER_FILE = 20;

/* ------------------------- git config parsing ------------------------ */

function unquote(raw) {
  let out = '';
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'b' ? '\b' : n;
    } else if (c === '"') inQ = !inQ;
    else if (!inQ && (c === ';' || c === '#')) break;
    else out += c;
  }
  return out.trim();
}

/** Parse INI-like git config text into [{ line, section, sub, name, value }]. */
function parseGitConfig(text) {
  const entries = [];
  const lines = text.split(/\r\n|\n|\r/);
  let section = '';
  let sub = null;
  for (let i = 0; i < lines.length; i++) {
    const startLine = i + 1;
    let l = lines[i];
    // A trailing backslash continues the value on the next line.
    while (/\\$/.test(l) && !/\\\\$/.test(l) && i + 1 < lines.length) l = l.slice(0, -1) + lines[++i];
    l = l.trim();
    if (!l || l[0] === '#' || l[0] === ';') continue;
    let rest = l;
    const sm = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(l);
    if (sm) {
      const head = sm[1].toLowerCase();
      const dot = head.indexOf('.');
      if (sm[2] === undefined && dot > 0) { section = head.slice(0, dot); sub = head.slice(dot + 1); } else { section = head; sub = sm[2] === undefined ? null : sm[2]; }
      rest = sm[3].trim();
      if (!rest || rest[0] === '#' || rest[0] === ';') continue;
    }
    const km = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*([\s\S]*))?$/.exec(rest);
    if (!km || !section) continue;
    entries.push({ line: startLine, section, sub, name: km[1].toLowerCase(), value: km[2] === undefined ? null : unquote(km[2]) });
  }
  return entries;
}

/* ------------------------- classification --------------------------- */

const RUN_KEYS = new Set([
  'core.sshcommand', 'core.pager', 'core.editor', 'core.askpass', 'core.gitproxy', 'sequence.editor', 'diff.external',
  'credential.helper', 'gpg.program', 'gpg.ssh.defaultkeycommand', 'uploadpack.packobjectshook',
]);
// section.<subsection>.name
const RUN_SUB_KEYS = {
  diff: ['command', 'textconv'],
  merge: ['driver'],
  mergetool: ['cmd', 'path'],
  difftool: ['cmd', 'path'],
  filter: ['clean', 'smudge', 'process'],
  credential: ['helper'],
  gpg: ['program'],
  pager: null, // pager.<command> holds a program unless it is a boolean
  browser: ['cmd', 'path'],
  man: ['cmd', 'path'],
};
const DISPLAY = { 'core.sshcommand': 'sshCommand', 'core.askpass': 'askPass', 'core.gitproxy': 'gitProxy', 'core.hookspath': 'hooksPath', 'core.fsmonitor': 'fsmonitor', 'gpg.program': 'program', 'uploadpack.packobjectshook': 'packObjectsHook' };
const BOOL = /^(true|false|yes|no|on|off|0|1)$/i;

function insideTree(rootReal, abs) {
  const rel = path.relative(rootReal, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Returns a short reason (key names only, no value) or null. */
function classify(e, ctx) {
  const v = e.value;
  const shown = DISPLAY[e.section + '.' + e.name] || e.name;
  const keyName = (e.sub === null ? e.section + '.' + shown : e.section + '.<name>.' + e.name);
  if (e.section === 'core' && e.name === 'fsmonitor') {
    if (v === null || v === '' || BOOL.test(v)) return null;
    return 'core.fsmonitor names a program that git runs on status, diff and commit';
  }
  if (e.section === 'core' && e.name === 'hookspath') {
    if (!v) return null;
    const target = path.resolve(ctx.workTree, v);
    return insideTree(ctx.rootReal, target) ? 'core.hooksPath points at a folder inside the repository, so its files run as git hooks' : null;
  }
  if (e.section === 'include' || (e.section === 'includeif' && e.name === 'path') || (e.section === 'include' && e.name === 'path')) {
    if (e.name !== 'path' || !v || v.startsWith('~')) return null;
    const target = path.resolve(ctx.configDir, v);
    return insideTree(ctx.rootReal, target) ? (e.section === 'include' ? 'include.path' : 'includeIf.<condition>.path') + ' loads a config file from the working tree' : null;
  }
  if (v === null || v === '') return null; // an empty value resets the setting
  if (e.section === 'core' && e.name === 'pager' && BOOL.test(v)) return null;
  if (e.sub === null && RUN_KEYS.has(e.section + '.' + e.name)) return keyName + ' makes git run a program';
  if (e.sub !== null) {
    const names = RUN_SUB_KEYS[e.section];
    if (e.section === 'pager') return BOOL.test(v) ? null : 'pager.<command> makes git run a program';
    if (RUN_KEYS.has(e.section + '.' + e.sub + '.' + e.name)) return keyName + ' makes git run a program';
    if (names && names.includes(e.name)) return keyName + ' makes git run a program';
  }
  return null;
}

/* ----------------------------- the checks ---------------------------- */

function checkConfigFile(abs, display, ctx, out) {
  const r = ctx.readBounded(abs, MAX_CONFIG_BYTES, false);
  if (r.skip === 'missing') return;
  if (r.skip) {
    ctx.unchecked.push({
      file: display, severity: 'high',
      detail: display + (r.skip === 'symlink' ? ' is a symbolic link; git reads it, zn audit does not follow it.' : r.skip === 'too-large' ? ' is larger than the 1 MiB zn audit reads.' : ' could not be read.') + ' It was not checked for programs git would run.',
    });
    return;
  }
  const dirReal = path.dirname(abs);
  const here = { rootReal: ctx.rootReal, workTree: ctx.root, configDir: dirReal };
  let n = 0;
  for (const e of parseGitConfig(r.text)) {
    const why = classify(e, here);
    if (!why) continue;
    if (++n > MAX_FINDINGS_PER_FILE) break;
    out.push({
      id: 'ZNA024', severity: 'high', agent: 'any', file: display, line: e.line,
      title: ctx.rule('ZNA024').title, detail: ctx.redact(display + ': ' + why + '. The value is not shown.'),
      evidence: ctx.redact(display + ' line ' + e.line), fix: ctx.rule('ZNA024').fix, references: [], _readers: ctx.readers,
    });
  }
}

function isBareLayout(entries) {
  const has = (n, dir) => entries.some((d) => d.name === n && (dir ? d.isDirectory() : d.isFile()));
  return has('HEAD', false) && has('objects', true) && has('refs', true);
}

function walkRepos(ctx, out) {
  let count = 0;
  const visit = (dir, rel, depth) => {
    if (ctx.cut || Date.now() > ctx.deadline) { ctx.cut = ctx.cut || 'time'; return; }
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    list.sort((a, b) => (a.name < b.name ? -1 : 1));
    if (rel && isBareLayout(list)) {
      out.push({
        id: 'ZNA025', severity: 'high', agent: 'any', file: rel, line: 1,
        title: ctx.rule('ZNA025').title, detail: ctx.redact(rel + ' is a bare git repository inside the working tree; git commands run in it use its own config.'),
        evidence: ctx.redact(rel), fix: ctx.rule('ZNA025').fix, references: [], _readers: ctx.readers,
      });
      checkConfigFile(path.join(dir, 'config'), rel + '/config', ctx, out);
      return;
    }
    for (const d of list) {
      if (++count > MAX_WALK_ENTRIES) { ctx.cut = ctx.cut || 'entries'; return; }
      if (!d.isDirectory()) continue; // symbolic links are not directories here: never followed
      const sub = rel ? rel + '/' + d.name : d.name;
      if (d.name === '.git') {
        if (rel) checkConfigFile(path.join(dir, '.git', 'config'), sub + '/config', ctx, out);
        continue;
      }
      if (depth + 1 > MAX_WALK_DEPTH) { ctx.cut = ctx.cut || 'depth'; continue; }
      visit(path.join(dir, d.name), sub, depth + 1);
    }
  };
  visit(ctx.root, '', 0);
}

/**
 * @param {object} deps { root, readBounded, redact, rule(id), readers, deadline, checkShadowing }
 * @returns {{ unchecked: Array, cut: (string|null) }}
 */
function preOpen(out, deps) {
  let rootReal = deps.root;
  try { rootReal = fs.realpathSync(deps.root); } catch (_) { /* keep */ }
  const ctx = Object.assign({}, deps, { rootReal, unchecked: [], cut: null });
  // The repository's own config.
  let gst = null;
  try { gst = fs.lstatSync(path.join(deps.root, '.git')); } catch (_) { gst = null; }
  if (gst && gst.isDirectory()) {
    checkConfigFile(path.join(deps.root, '.git', 'config'), '.git/config', ctx, out);
  } else if (gst) {
    ctx.unchecked.push({ file: '.git', severity: gst.isSymbolicLink() ? 'high' : 'medium', detail: '.git is ' + (gst.isSymbolicLink() ? 'a symbolic link' : 'a file that points at another git folder') + '; its config was not followed and was not checked for programs git would run.' });
  }
  // A folder that is itself a bare repository.
  try {
    const top = fs.readdirSync(deps.root, { withFileTypes: true });
    if (!gst && isBareLayout(top)) checkConfigFile(path.join(deps.root, 'config'), 'config', ctx, out);
  } catch (_) { /* ignore */ }
  walkRepos(ctx, out);
  // Executables named like tools in folders that are often on PATH.
  for (const sub of ['bin', '.bin']) deps.checkShadowing(deps.root, out, sub, 'ZNA026');
  return { unchecked: ctx.unchecked, cut: ctx.cut };
}

module.exports = { preOpen, parseGitConfig, classify, MAX_CONFIG_BYTES };
