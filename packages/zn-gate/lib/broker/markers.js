'use strict';

/**
 * Markers and policy matching shared by `zn run`, the `secrets` MCP server
 * and the agent hooks.
 *
 *   __ZN_<NAME>__      a named secret from the vault (e.g. __ZN_GITHUB_TOKEN__)
 *   __ZN_<TYPE>_<n>__  a value the scrubber detected (e.g. __ZN_AWS_KEY_1__)
 *
 * Vault names may not end in `_<digits>`, so the two forms never collide.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME_SOURCE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
const MARKER_SOURCE = '__ZN_(' + NAME_SOURCE + ')__';
const NAME_RE = new RegExp('^' + NAME_SOURCE + '$');
const DETECTED_RE = /_\d+$/;

function markerRegex() {
  return new RegExp(MARKER_SOURCE, 'g');
}

function markerFor(name) {
  return '__ZN_' + name + '__';
}

function isDetectedName(name) {
  return DETECTED_RE.test(name);
}

/** Validate a vault secret name. Returns an error message or null. */
function validateSecretName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return 'secret names use upper-case letters, digits and single underscores (e.g. GITHUB_TOKEN)';
  }
  if (name.length > 64) return 'secret names are at most 64 characters';
  if (isDetectedName(name)) {
    return 'secret names may not end in _<digits>: that form is reserved for values the scrubber detects';
  }
  return null;
}

/** All markers in a string: [{marker, name, detected}] (deduplicated, in order). */
function findMarkers(text) {
  const out = [];
  const seen = new Set();
  if (typeof text !== 'string' || !text.includes('__ZN_')) return out;
  for (const m of text.matchAll(markerRegex())) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ marker: m[0], name: m[1], detected: isDetectedName(m[1]) });
  }
  return out;
}

function findNamedMarkers(text) {
  return findMarkers(text).filter((m) => !m.detected);
}

/** Replace named markers using a Map name -> value. Unknown names stay as they are. */
function substitute(text, values) {
  if (typeof text !== 'string' || !text.includes('__ZN_')) return text;
  return text.replace(markerRegex(), (whole, name) => (values.has(name) ? values.get(name) : whole));
}

/* ---------------------------- commands ---------------------------- */

function normalizeExe(p) {
  let base = path.basename(String(p || ''));
  if (process.platform === 'win32') {
    base = base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
  }
  return base;
}

function hasPathSeparator(s) {
  return /[\\/]/.test(String(s || ''));
}

/**
 * Does argv match one allowCommands entry? An entry is a command prefix:
 * "psql" matches `psql ...`; "npm run migrate" matches `npm run migrate ...`.
 * A bare entry only matches a bare argv[0] (resolved on PATH), never an
 * explicit path such as ./psql. A path entry must match argv[0] exactly.
 */
function matchCommandEntry(entry, argv) {
  const words = String(entry || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !Array.isArray(argv) || argv.length < words.length) return false;
  const head = words[0];
  if (hasPathSeparator(head)) {
    if (path.resolve(head) !== path.resolve(argv[0])) return false;
  } else {
    if (hasPathSeparator(argv[0])) return false;
    if (normalizeExe(head) !== normalizeExe(argv[0])) return false;
  }
  for (let i = 1; i < words.length; i++) {
    if (words[i] !== argv[i]) return false;
  }
  return true;
}

/** First allowCommands entry that matches argv, or null. */
function matchAllowCommands(allowCommands, argv) {
  for (const entry of allowCommands || []) {
    if (matchCommandEntry(entry, argv)) return String(entry).trim().split(/\s+/).join(' ');
  }
  return null;
}

/** Locate an executable on PATH (PATHEXT aware on Windows). */
function whichSync(cmd, envPath) {
  if (hasPathSeparator(cmd)) return fs.existsSync(cmd) ? path.resolve(cmd) : null;
  const dirs = String(envPath || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * An allowed command name must not resolve to a binary the agent could have
 * planted: inside the project (except node_modules/.bin) or in the temp dir.
 * Returns an error message or null.
 */
function checkResolvedExecutable(resolved, projectRoot) {
  if (!resolved) return 'command not found on PATH';
  const real = (() => { try { return fs.realpathSync(resolved); } catch (_) { return resolved; } })();
  const tmp = (() => { try { return fs.realpathSync(os.tmpdir()); } catch (_) { return os.tmpdir(); } })();
  if (isInside(real, tmp)) return 'resolves to a file in the temp directory';
  if (projectRoot && isInside(real, projectRoot)) {
    const binDir = path.join(projectRoot, 'node_modules', '.bin');
    const nm = path.join(projectRoot, 'node_modules');
    if (!isInside(resolved, binDir) && !isInside(real, nm)) {
      return 'resolves to a file inside the project, which the agent can edit';
    }
  }
  return null;
}

/* ------------------------------ hosts ------------------------------ */

/** allowHosts entries: "api.github.com" (exact) or "*.example.com" (subdomains only). */
function hostAllowed(allowHosts, host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const raw of allowHosts || []) {
    const entry = String(raw || '').toLowerCase().trim().replace(/\.$/, '');
    if (!entry) continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (entry === h) {
      return true;
    }
  }
  return false;
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

module.exports = {
  MARKER_SOURCE,
  markerRegex,
  markerFor,
  isDetectedName,
  validateSecretName,
  findMarkers,
  findNamedMarkers,
  substitute,
  normalizeExe,
  matchCommandEntry,
  matchAllowCommands,
  whichSync,
  isInside,
  checkResolvedExecutable,
  hostAllowed,
  isLoopbackHost,
};
