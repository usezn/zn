'use strict';

// Baseline of the executable configuration of a project: what the person approved, as one hash per entry, so a later change to a command,
// a hook (its matcher included), an environment override, a permission or an install script can be told apart from a harmless reformat.
// Only entry names and hashes are stored (never a value or a path), in a file private to the user.
//
//   extractSurface(root)           -> { '<file>#<kind>:<name>': '<sha256 hex>' }
//   diffSurface(base, now)         -> { added: [...], changed: [...], removed: [...] }
//   baselinePath(home, root)       -> where the baseline of this project is kept (the real folder, not the way it was spelled)
//   saveBaseline / loadBaseline    -> write it (0600) / read it (null when missing or damaged)
//
// A file that is there but cannot be read (too large, not valid, a link that leaves the project or is broken) is one entry of its own,
// `<file>#unreadable`, hashed from what can still be told of it, so turning a file into one of those is a change, not a removal.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseJsonc, parseToml } = require('./parse');

const MAX_FILE = 1024 * 1024;
const MAX_HASHED = 8 * 1024 * 1024;
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack'];
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.json', '.cursor/hooks.json', '.gemini/settings.json'];
const MCP_FILES = [
  ['.mcp.json', 'mcpServers'], ['.cursor/mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'servers'], ['.gemini/settings.json', 'mcpServers'],
  ['.amazonq/mcp.json', 'mcpServers'], ['opencode.json', 'mcp'], ['opencode.jsonc', 'mcp'], ['.opencode/opencode.json', 'mcp'], ['.codex/config.toml', 'mcp_servers'],
];
const SCALAR_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'statusLine', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disableAllHooks', 'otelHeadersHelper'];
const ENV_RE = /^(?:(?:ANTHROPIC|OPENAI|GOOGLE|GEMINI)_.*(?:URL|ENDPOINT|HOST)|(?:HTTPS?|ALL)_PROXY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|CLAUDE_CODE_SHELL_PREFIX|PERL5OPT|BASH_ENV|ENV|PATH|PYTHONPATH|GIT_SSH_COMMAND|SSL_CERT_FILE|REQUESTS_CA_BUNDLE)$/i;
const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'];
const DEVCONTAINER_KEYS = ['initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'];

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function realOf(p) {
  try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); }
}

function insideOf(realRoot, real) {
  const r = path.relative(realRoot, real);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}

/** { kind: 'missing' } | { kind: 'ok', value } | { kind: 'bad', hash }. A link is followed when it stays inside the project. */
function readConfig(root, realRoot, rel) {
  const file = path.join(root, rel);
  let lst;
  try { lst = fs.lstatSync(file); } catch (_) { return { kind: 'missing' }; }
  let target = file;
  if (lst.isSymbolicLink()) {
    let real;
    try { real = fs.realpathSync.native(file); } catch (_) { return { kind: 'bad', hash: sha(['broken-link']) }; }
    if (!insideOf(realRoot, real)) {
      // What the agent loads is the content of the target: its size and digest are the hash (the path is not kept).
      try {
        const st0 = fs.statSync(real);
        const body = st0.isFile() && st0.size <= MAX_HASHED ? fs.readFileSync(real) : null;
        return { kind: 'bad', hash: sha(['link-outside', st0.size, body ? crypto.createHash('sha256').update(body).digest('hex') : '']) };
      } catch (_) {
        return { kind: 'bad', hash: sha(['link-outside-unreadable']) };
      }
    }
    target = real;
  }
  let st;
  try { st = fs.statSync(target); } catch (_) { return { kind: 'bad', hash: sha(['unreadable']) }; }
  if (!st.isFile()) return { kind: 'bad', hash: sha(['not-a-file']) };
  let buf;
  try { buf = st.size <= MAX_HASHED ? fs.readFileSync(target) : null; } catch (_) { return { kind: 'bad', hash: sha(['unreadable']) }; }
  const digest = buf ? crypto.createHash('sha256').update(buf).digest('hex') : '';
  if (st.size > MAX_FILE) return { kind: 'bad', hash: sha(['large', st.size, digest]) };
  try {
    const text = buf.toString('utf8');
    const v = rel.endsWith('.toml') ? parseToml(text).data : parseJsonc(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { kind: 'ok', value: v };
  } catch (_) { /* below */ }
  return { kind: 'bad', hash: sha(['invalid', digest]) };
}

// An object with its keys sorted, so reordering is not a change; arrays keep their order (arguments are ordered).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

// Each hook is hashed with the matcher of its group: a hook that no longer matches the tools it guarded is a change.
function hookCommands(hooks, out, rel) {
  if (!hooks || typeof hooks !== 'object') return;
  for (const event of Object.keys(hooks).sort()) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    groups.forEach((g, gi) => {
      const grouped = g && Array.isArray(g.hooks);
      const list = grouped ? g.hooks : [g];
      list.forEach((h, hi) => {
        if (h && typeof h === 'object') out[rel + '#hook:' + event + '.' + gi + '.' + hi] = sha(canon(grouped ? { matcher: g.matcher, hook: h } : h));
      });
    });
  }
}

function extractSurface(root) {
  const out = {};
  const realRoot = realOf(root);
  const bad = new Set();
  const read = (rel) => {
    const c = readConfig(root, realRoot, rel);
    if (c.kind === 'bad' && !bad.has(rel)) { bad.add(rel); out[rel + '#unreadable'] = c.hash; }
    return c.kind === 'ok' ? c.value : null;
  };
  for (const [rel, field] of MCP_FILES) {
    const j = read(rel);
    const servers = j && j[field];
    if (servers && typeof servers === 'object') for (const name of Object.keys(servers).sort()) out[rel + '#mcp:' + name] = sha(canon(servers[name]));
  }
  for (const rel of SETTINGS_FILES) {
    const j = read(rel);
    if (!j) continue;
    hookCommands(j.hooks, out, rel);
    if (j.env && typeof j.env === 'object') for (const k of Object.keys(j.env).sort()) if (ENV_RE.test(k)) out[rel + '#env:' + k] = sha(j.env[k]);
    if (j.permissions !== undefined) out[rel + '#permissions'] = sha(canon(j.permissions));
    for (const k of SCALAR_SETTINGS) if (j[k] !== undefined) out[rel + '#setting:' + k] = sha(canon(j[k]));
  }
  for (const rel of DEVCONTAINER_FILES) {
    const j = read(rel);
    if (j) for (const k of DEVCONTAINER_KEYS) if (j[k] !== undefined) out[rel + '#devcontainer:' + k] = sha(canon(j[k]));
  }
  const pkg = read('package.json');
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') for (const k of LIFECYCLE) if (typeof pkg.scripts[k] === 'string') out['package.json#script:' + k] = sha(pkg.scripts[k]);
  const tasks = read('.vscode/tasks.json');
  if (tasks && Array.isArray(tasks.tasks)) {
    tasks.tasks.forEach((t, i) => {
      if (t && t.runOptions && t.runOptions.runOn === 'folderOpen') out['.vscode/tasks.json#task:' + String(t.label || i)] = sha(canon(t));
    });
  }
  return out;
}

function diffSurface(base, now) {
  const b = base && typeof base === 'object' ? base : {};
  const n = now && typeof now === 'object' ? now : {};
  const added = Object.keys(n).filter((k) => !(k in b)).sort();
  const removed = Object.keys(b).filter((k) => !(k in n)).sort();
  const changed = Object.keys(n).filter((k) => k in b && b[k] !== n[k]).sort();
  return { added, changed, removed };
}

// The real folder, with letter case folded where the file system ignores it, so a symlink to the project or another spelling finds the same baseline.
function baselinePath(home, root) {
  let real = realOf(root);
  if (process.platform === 'win32' || process.platform === 'darwin') real = real.toLowerCase();
  const id = crypto.createHash('sha256').update(real).digest('hex').slice(0, 32);
  return path.join(home, '.zn', 'baselines', id + '.json');
}

function saveBaseline(home, root, surface, now = new Date()) {
  const file = baselinePath(home, root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, approved_at: now.toISOString(), entries: surface }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function loadBaseline(home, root) {
  try {
    const j = JSON.parse(fs.readFileSync(baselinePath(home, root), 'utf8'));
    if (!j || j.version !== 1 || !j.entries || typeof j.entries !== 'object' || Array.isArray(j.entries)) return null;
    for (const v of Object.values(j.entries)) if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) return null;
    return j.entries;
  } catch (_) {
    return null;
  }
}

module.exports = { extractSurface, diffSurface, baselinePath, saveBaseline, loadBaseline };
