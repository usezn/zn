'use strict';

// Baseline of the executable configuration of a project: what the person approved, as one hash per entry, so a later change to a command,
// a hook, an environment override or an install script can be told apart from a harmless reformat. Only entry names and hashes are
// stored (never a value or a path), in a file private to the user.
//
//   extractSurface(root)           -> { '<file>#<kind>:<name>': '<sha256 hex>' }
//   diffSurface(base, now)         -> { added: [...], changed: [...], removed: [...] }
//   baselinePath(home, root)       -> where the baseline of this project is kept
//   saveBaseline / loadBaseline    -> write it (0600) / read it (null when missing or damaged)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseJsonc } = require('./parse');

const MAX_FILE = 1024 * 1024;
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack'];
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.json', '.cursor/hooks.json', '.gemini/settings.json'];
const MCP_FILES = [['.mcp.json', 'mcpServers'], ['.cursor/mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'servers'], ['.gemini/settings.json', 'mcpServers']];

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readJson(root, rel) {
  try {
    const file = path.join(root, rel);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const v = parseJsonc(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// An object with its keys sorted, so reordering is not a change; arrays keep their order (arguments are ordered).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

function hookCommands(hooks, out, rel) {
  if (!hooks || typeof hooks !== 'object') return;
  for (const event of Object.keys(hooks).sort()) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    groups.forEach((g, gi) => {
      const list = g && Array.isArray(g.hooks) ? g.hooks : [g];
      list.forEach((h, hi) => {
        if (h && typeof h === 'object') out[rel + '#hook:' + event + '.' + gi + '.' + hi] = sha(canon(h));
      });
    });
  }
}

function extractSurface(root) {
  const out = {};
  for (const [rel, field] of MCP_FILES) {
    const j = readJson(root, rel);
    const servers = j && j[field];
    if (servers && typeof servers === 'object') for (const name of Object.keys(servers).sort()) out[rel + '#mcp:' + name] = sha(canon(servers[name]));
  }
  for (const rel of SETTINGS_FILES) {
    const j = readJson(root, rel);
    if (!j) continue;
    hookCommands(j.hooks, out, rel);
    if (j.env && typeof j.env === 'object') for (const k of Object.keys(j.env).sort()) if (/^(ANTHROPIC|OPENAI|GOOGLE|GEMINI)_.*(URL|ENDPOINT|HOST)$|^(HTTPS?|ALL)_PROXY$|^NODE_OPTIONS$/i.test(k)) out[rel + '#env:' + k] = sha(j.env[k]);
    if (j.permissions && Array.isArray(j.permissions.allow)) out[rel + '#permissions.allow'] = sha([...j.permissions.allow].map(String).sort());
    for (const k of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'statusLine', 'enableAllProjectMcpServers']) if (j[k] !== undefined) out[rel + '#setting:' + k] = sha(canon(j[k]));
  }
  const pkg = readJson(root, 'package.json');
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') for (const k of LIFECYCLE) if (typeof pkg.scripts[k] === 'string') out['package.json#script:' + k] = sha(pkg.scripts[k]);
  const tasks = readJson(root, '.vscode/tasks.json');
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

function baselinePath(home, root) {
  const id = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32);
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
