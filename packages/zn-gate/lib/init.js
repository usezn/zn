'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/*
 * Config formats (verified against each agent's official docs, 2026-10-11):
 *
 *  - 'mcpServers-json' : JSON object { mcpServers: { name: { command, args } } }
 *                        (Claude Desktop, Claude Code, Cursor, Antigravity, Hermes)
 *  - 'opencode-json'   : ~/.config/opencode/opencode.json
 *                        { mcp: { name: { type: "local", command: ["npx", ...] } } }
 *                        https://opencode.ai/docs/mcp-servers/ , https://opencode.ai/docs/config/
 *  - 'codex-toml'      : ~/.codex/config.toml (or $CODEX_HOME/config.toml)
 *                        [mcp_servers.name]  command = "npx"  args = ["-y", ...]
 *                        https://developers.openai.com/codex/mcp
 *
 * We never rewrite a file we cannot round-trip safely: JSONC with comments and
 * TOML entries with multi-line arrays are reported as 'manual_required'.
 */

function getKnownEnvironments(projectDir) {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');

  const claudeDesktopPath = isWin
    ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : isMac
    ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(xdgConfig, 'Claude', 'claude_desktop_config.json');

  const opencodeDir = path.join(xdgConfig, 'opencode');
  const opencodeJson = path.join(opencodeDir, 'opencode.json');
  const opencodeJsonc = path.join(opencodeDir, 'opencode.jsonc');
  const opencodePath = !fs.existsSync(opencodeJson) && fs.existsSync(opencodeJsonc) ? opencodeJsonc : opencodeJson;

  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');

  // Antigravity: Google's MCP guides use ~/.gemini/antigravity/mcp_config.json;
  // other setup guides use a shared ~/.gemini/config/mcp_config.json. Both are
  // checked (each only if it exists), so servers in either file are covered.
  // A project can also have its own .agents/mcp_config.json (docs: antigravity.google/docs/mcp).

  return [
    { name: 'Claude Desktop', id: 'claude-desktop', filePath: claudeDesktopPath, key: 'mcpServers', format: 'mcpServers-json' },
    { name: 'Claude Code', id: 'claude-code', filePath: path.join(home, '.claude.json'), key: 'mcpServers', format: 'mcpServers-json' },
    { name: 'Cursor', id: 'cursor', filePath: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers', format: 'mcpServers-json' },
    { name: 'Antigravity (AGY)', id: 'antigravity', filePath: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), key: 'mcpServers', format: 'mcpServers-json' },
    { name: 'Antigravity (this project)', id: 'antigravity-project', filePath: path.join(projectDir || process.cwd(), '.agents', 'mcp_config.json'), key: 'mcpServers', format: 'mcpServers-json', scope: 'project' },
    { name: 'Antigravity (shared settings)', id: 'antigravity-shared', filePath: path.join(home, '.gemini', 'config', 'mcp_config.json'), key: 'mcpServers', format: 'mcpServers-json' },
    { name: 'Codex', id: 'codex', filePath: path.join(codexHome, 'config.toml'), key: 'mcp_servers', format: 'codex-toml' },
    { name: 'OpenCode', id: 'opencode', filePath: opencodePath, key: 'mcp', format: 'opencode-json' },
    { name: 'Hermes / PiAgent', id: 'hermes-piagent', filePath: path.join(home, '.hermes', 'mcp.json'), key: 'mcpServers', format: 'mcpServers-json' },
  ];
}

function isShieldedCommand(cmd, args) {
  const joined = [cmd || '', ...(args || [])].join(' ');
  return /\bzn-gate\b|\bzn-mcp\b/.test(joined) || (args || []).includes('shield');
}

function shieldArgv(originalArgv, options) {
  const argv = ['-y', 'zn-gate', 'shield'];
  if (options.shadow) argv.push('--shadow');
  argv.push('--', ...originalArgv);
  return argv;
}

/**
 * Inverse of shieldArgv: the original [command, ...args] of a server that
 * `init --wrap-mcp` wrapped, read from the argument list that follows `npx`
 * (-y zn-gate shield [--shadow] -- <original>). Returns null for anything else,
 * so only entries written by init are ever rewritten.
 */
function unshieldArgv(argv) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return null;
  if (argv[0] !== '-y' || argv[1] !== 'zn-gate' || argv[2] !== 'shield') return null;
  let i = 3;
  if (argv[i] === '--shadow') i++;
  if (argv[i] !== '--') return null;
  const original = argv.slice(i + 1);
  return original.length > 0 && original[0] !== '' ? original : null;
}

/** True when an entry names the shield wrapper in some form that unshieldArgv does not understand. */
function looksWrapped(command, args) {
  return isShieldedCommand(command, args) && /\bshield\b/.test([command || '', ...(args || [])].join(' '));
}

const LEFT_WRAPPED = 'wrapped in a form zn-gate did not write; put the original command back by hand';

// ---------------------------------------------------------------------------
// Adapter: { mcpServers: { name: { command, args } } }  (and custom `key`)
// ---------------------------------------------------------------------------
const mcpServersJson = {
  list(raw, env) {
    const json = JSON.parse(raw);
    const srvs = json[env.key || 'mcpServers'] || {};
    return Object.entries(srvs).map(([name, cfg]) => {
      const command = (cfg && cfg.command) || '';
      const args = (cfg && cfg.args) || [];
      return { name, command, args, shielded: isShieldedCommand(command, args), remote: !command };
    });
  },
  shield(raw, env, options) {
    const json = JSON.parse(raw);
    const srvs = json[env.key || 'mcpServers'] || {};
    let modified = false;
    for (const cfg of Object.values(srvs)) {
      if (!cfg || !cfg.command) continue; // remote/url servers: nothing to wrap
      const args = cfg.args || [];
      if (isShieldedCommand(cfg.command, args)) continue;
      cfg.args = shieldArgv([cfg.command, ...args], options);
      cfg.command = 'npx';
      modified = true;
    }
    return { modified, content: JSON.stringify(json, null, 2) + '\n', manual: [] };
  },
  /** Puts each wrapped server's original command back; every other entry and key stays as it is now. */
  unshield(raw, env) {
    const json = JSON.parse(raw);
    const srvs = json[env.key || 'mcpServers'] || {};
    const manual = [];
    let count = 0;
    for (const [name, cfg] of Object.entries(srvs)) {
      if (!cfg || typeof cfg.command !== 'string') continue;
      const original = cfg.command === 'npx' ? unshieldArgv(cfg.args) : null;
      if (original) {
        cfg.command = original[0];
        if (original.length > 1) cfg.args = original.slice(1);
        else delete cfg.args;
        count++;
      } else if (looksWrapped(cfg.command, cfg.args)) {
        manual.push(`${name}: ${LEFT_WRAPPED}`);
      }
    }
    return { modified: count > 0, count, content: JSON.stringify(json, null, 2) + '\n', manual };
  },
};

// ---------------------------------------------------------------------------
// Adapter: OpenCode  { mcp: { name: { type: "local", command: [..] } } }
// ---------------------------------------------------------------------------
function parseStrictJson(raw, filePath) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`${path.basename(filePath)} is not strict JSON (comments/trailing commas?). Not rewriting it; add zn-gate manually.`);
    err.manual = true;
    throw err;
  }
}

const opencodeJson = {
  list(raw, env) {
    const json = parseStrictJson(raw, env.filePath);
    const srvs = json.mcp || {};
    return Object.entries(srvs).map(([name, cfg]) => {
      const argv = Array.isArray(cfg && cfg.command) ? cfg.command : [];
      const local = cfg && cfg.type === 'local' && argv.length > 0;
      return { name, command: argv[0] || '', args: argv.slice(1), shielded: local && isShieldedCommand(argv[0], argv.slice(1)), remote: !local };
    });
  },
  shield(raw, env, options) {
    const json = parseStrictJson(raw, env.filePath);
    const srvs = json.mcp || {};
    let modified = false;
    for (const cfg of Object.values(srvs)) {
      if (!cfg || cfg.type !== 'local' || !Array.isArray(cfg.command) || cfg.command.length === 0) continue;
      if (isShieldedCommand(cfg.command[0], cfg.command.slice(1))) continue;
      cfg.command = ['npx', ...shieldArgv(cfg.command, options)];
      modified = true;
    }
    return { modified, content: JSON.stringify(json, null, 2) + '\n', manual: [] };
  },
  unshield(raw, env) {
    const json = parseStrictJson(raw, env.filePath);
    const srvs = json.mcp || {};
    const manual = [];
    let count = 0;
    for (const [name, cfg] of Object.entries(srvs)) {
      if (!cfg || cfg.type !== 'local' || !Array.isArray(cfg.command) || cfg.command.length === 0) continue;
      const original = cfg.command[0] === 'npx' ? unshieldArgv(cfg.command.slice(1)) : null;
      if (original) {
        cfg.command = original;
        count++;
      } else if (looksWrapped(cfg.command[0], cfg.command.slice(1))) {
        manual.push(`${name}: ${LEFT_WRAPPED}`);
      }
    }
    return { modified: count > 0, count, content: JSON.stringify(json, null, 2) + '\n', manual };
  },
};

// ---------------------------------------------------------------------------
// Adapter: Codex config.toml  [mcp_servers.<name>] command = "..." args = [..]
// Minimal, line-based and conservative (zero dependencies). Only single-line
// `command` strings and single-line `args` arrays of strings are rewritten.
// ---------------------------------------------------------------------------
const TOML_HEADER = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/;

function parseTomlKeyPath(keyPath) {
  // Splits a dotted key like mcp_servers."my server" into parts.
  const parts = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let m;
  let consumed = 0;
  re.lastIndex = 0;
  while (consumed < keyPath.length && (m = re.exec(keyPath)) !== null) {
    if (m[0].length === 0) break;
    try {
      parts.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3]);
    } catch (_) {
      return [];
    }
    consumed = re.lastIndex;
  }
  return consumed === keyPath.length ? parts : [];
}

function parseTomlString(src) {
  // Returns [value, rest] for a basic "..." or literal '...' string at the start of src.
  const s = src.trimStart();
  if (s.startsWith('"""') || s.startsWith("'''")) return null; // multi-line strings: unsupported
  let m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) {
    try {
      return [JSON.parse(`"${m[1]}"`), s.slice(m[0].length)];
    } catch (_) {
      return null;
    }
  }
  m = /^'([^']*)'/.exec(s);
  if (m) return [m[1], s.slice(m[0].length)];
  return null;
}

function parseTomlStringArray(src) {
  // Parses a single-line ["a", 'b'] array of strings. Returns array or null.
  let s = src.trim();
  if (!s.startsWith('[')) return null;
  s = s.slice(1);
  const out = [];
  for (;;) {
    s = s.trimStart();
    if (s.startsWith(']')) {
      const tail = s.slice(1).trim();
      return tail === '' || tail.startsWith('#') ? out : null;
    }
    const r = parseTomlString(s);
    if (!r) return null;
    out.push(r[0]);
    s = r[1].trimStart();
    if (s.startsWith(',')) s = s.slice(1);
    else if (!s.startsWith(']')) return null;
  }
}

function tomlStr(v) {
  return JSON.stringify(String(v)); // JSON string escapes are valid TOML basic strings
}

function scanCodexToml(raw) {
  const lines = raw.split(/\r?\n/);
  const servers = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const h = TOML_HEADER.exec(lines[i]);
    if (h && !lines[i].trim().startsWith('[[')) {
      const parts = parseTomlKeyPath(h[1]);
      if (parts.length === 2 && parts[0] === 'mcp_servers') {
        current = { name: parts[1], headerLine: i, commandLine: -1, argsLine: -1, command: null, args: null, unsupported: null, url: false };
        servers.push(current);
      } else {
        current = null; // any other table (including mcp_servers.x.env) ends the section
      }
      continue;
    }
    if (!current) continue;
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'command') {
      const r = parseTomlString(value);
      const rest = r ? r[1].trim() : '';
      if (r && (rest === '' || rest.startsWith('#'))) {
        current.command = r[0];
        current.commandLine = i;
      } else current.unsupported = 'command is not a single-line string';
    } else if (key === 'args') {
      const arr = parseTomlStringArray(value);
      if (arr) {
        current.args = arr;
        current.argsLine = i;
      } else current.unsupported = 'args is not a single-line array of strings';
    } else if (key === 'url') {
      current.url = true;
    }
  }
  return { lines, servers };
}

/** Text after the closing bracket of a single-line string array when it is a "# comment" (with its spaces), else ''. */
function tomlArrayComment(src) {
  let s = src.trim();
  if (!s.startsWith('[')) return '';
  s = s.slice(1);
  for (;;) {
    s = s.trimStart();
    if (s.startsWith(']')) {
      const rest = s.slice(1);
      return rest.trim().startsWith('#') ? rest.trimEnd() : '';
    }
    const r = parseTomlString(s);
    if (!r) return '';
    s = r[1].trimStart();
    if (s.startsWith(',')) s = s.slice(1);
    else if (!s.startsWith(']')) return '';
  }
}

function tomlStringComment(src) {
  const r = parseTomlString(src);
  if (!r) return '';
  return r[1].trim().startsWith('#') ? r[1].trimEnd() : '';
}

const codexToml = {
  list(raw) {
    return scanCodexToml(raw).servers.map((s) => ({
      name: s.name,
      command: s.command || '',
      args: s.args || [],
      shielded: Boolean(s.command) && isShieldedCommand(s.command, s.args || []),
      remote: !s.command,
    }));
  },
  shield(raw, env, options) {
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const { lines, servers } = scanCodexToml(raw);
    const manual = [];
    let modified = false;
    // Process bottom-up so inserted lines don't shift later indices.
    for (const s of [...servers].sort((a, b) => b.headerLine - a.headerLine)) {
      if (!s.command) continue; // streamable-HTTP (url) servers: nothing to wrap
      if (s.unsupported) {
        manual.push(`${s.name}: ${s.unsupported}`);
        continue;
      }
      const args = s.args || [];
      if (isShieldedCommand(s.command, args)) continue;
      const newArgs = shieldArgv([s.command, ...args], options);
      lines[s.commandLine] = `command = ${tomlStr('npx')}`;
      const argsLine = `args = [${newArgs.map(tomlStr).join(', ')}]`;
      if (s.argsLine >= 0) lines[s.argsLine] = argsLine;
      else lines.splice(s.commandLine + 1, 0, argsLine);
      modified = true;
    }
    return { modified, content: lines.join(eol), manual };
  },
  /** Puts each wrapped server's original command back, line by line; comments, line endings and other tables stay. */
  unshield(raw) {
    const eols = (raw.match(/\r?\n/g) || []).concat('');
    const { lines, servers } = scanCodexToml(raw);
    const manual = [];
    let count = 0;
    // Bottom-up so a removed line does not shift later indices.
    for (const s of [...servers].sort((a, b) => b.headerLine - a.headerLine)) {
      if (!s.command) continue;
      if (s.unsupported) {
        let end = s.headerLine + 1;
        while (end < lines.length && !TOML_HEADER.test(lines[end])) end++;
        const section = lines.slice(s.headerLine + 1, end).join('\n');
        if (/\bzn-gate\b/.test(section) && /\bshield\b/.test(section)) manual.push(`${s.name}: ${LEFT_WRAPPED}`);
        continue;
      }
      const original = s.command === 'npx' ? unshieldArgv(s.args) : null;
      if (!original) {
        if (looksWrapped(s.command, s.args || [])) manual.push(`${s.name}: ${LEFT_WRAPPED}`);
        continue;
      }
      const cmdValue = /^\s*[A-Za-z0-9_-]+\s*=\s*(.*)$/.exec(lines[s.commandLine])[1];
      const argsValue = /^\s*[A-Za-z0-9_-]+\s*=\s*(.*)$/.exec(lines[s.argsLine])[1];
      const argsComment = tomlArrayComment(argsValue);
      lines[s.commandLine] = `command = ${tomlStr(original[0])}${tomlStringComment(cmdValue)}`;
      if (original.length > 1 || argsComment) {
        lines[s.argsLine] = `args = [${original.slice(1).map(tomlStr).join(', ')}]${argsComment}`;
      } else {
        lines.splice(s.argsLine, 1);
        eols.splice(s.argsLine, 1);
      }
      count++;
    }
    return { modified: count > 0, count, content: lines.map((l, i) => l + (eols[i] || '')).join(''), manual };
  },
};

const ADAPTERS = {
  'mcpServers-json': mcpServersJson,
  'opencode-json': opencodeJson,
  'codex-toml': codexToml,
};

function adapterFor(env) {
  return ADAPTERS[env.format || 'mcpServers-json'] || mcpServersJson;
}

/**
 * Scans the filesystem for the supported agent environments.
 */
function scanEnvironments(customEnvList = null, projectDir) {
  const envs = customEnvList || getKnownEnvironments(projectDir);
  const results = [];

  for (const env of envs) {
    const exists = fs.existsSync(env.filePath);
    let servers = [];

    if (exists) {
      try {
        const raw = fs.readFileSync(env.filePath, 'utf8');
        servers = adapterFor(env).list(raw, env);
      } catch (e) {
        servers = [{ name: 'error', error: e.message }];
      }
    }

    const valid = servers.filter((s) => !s.error);
    results.push({
      ...env,
      exists,
      servers,
      serverCount: valid.length,
      allShielded: valid.length > 0 && valid.filter((s) => !s.remote).every((s) => s.shielded),
    });
  }

  return results;
}

/**
 * Symlink-safe backup helpers. A config path can be controlled by a repository
 * (the project-level agent config), so backups are never chosen by name order
 * and nothing is read or written through a symlink.
 */
function isRegularFile(p, singleLink) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && (!singleLink || st.nlink === 1);
  } catch {
    return false;
  }
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where a config really lives, or why it cannot be touched safely.
 * Project scope (a repository controls it): a plain file with one link, whose
 * real directory is inside the current directory. Home scope: a plain file, or
 * a symlink (dotfiles managers) to a regular file inside the home folder and
 * outside the current directory.
 */
function resolveConfig(filePath, scope, projectDir) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    return { reason: 'config is not a regular file' };
  }
  if (scope === 'project') {
    if (!st.isFile()) return { reason: 'config is a symlink or not a regular file' };
    if (st.nlink !== 1) return { reason: 'config has more than one hard link' };
    const dir = realOrNull(path.dirname(filePath));
    const cwd = realOrNull(projectDir || process.cwd());
    if (!dir || !cwd || !isInside(dir, cwd)) return { reason: 'config directory is outside the project' };
    return { target: filePath };
  }
  if (st.isFile()) return { target: filePath };
  if (!st.isSymbolicLink()) return { reason: 'config is not a regular file' };
  const real = realOrNull(filePath);
  const home = realOrNull(os.homedir());
  const cwd = realOrNull(projectDir || process.cwd());
  if (!real || !home || !isRegularFile(real)) return { reason: 'config is a symlink to something other than a regular file' };
  if (!isInside(real, home)) {
    return { reason: 'config is a symlink that points outside your home folder; move the real file into your home folder, or wrap this server by hand' };
  }
  if (cwd && cwd !== home && isInside(real, cwd)) return { reason: 'config is a symlink that points into the current project' };
  return { target: real };
}

/** Writes content to a temp file next to target, then renames it over target. */
function atomicWrite(target, content) {
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {}
  const tmpFile = path.join(path.dirname(target), `.${path.basename(target)}.zn-tmp.${process.pid}.${Date.now()}`);
  let created = false;
  try {
    fs.writeFileSync(tmpFile, content, { flag: 'wx', mode });
    created = true;
    try {
      fs.chmodSync(tmpFile, mode);
    } catch {}
    renameWithRetry(tmpFile, target);
  } catch (err) {
    if (created) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
    throw err;
  }
}

/**
 * Copies src to a new backup file without ever overwriting or writing through
 * an existing entry (including a dangling symlink) at the backup name.
 * Content goes to a temp file opened with 'wx', then is renamed into place.
 */
function createBackup(src, backup) {
  const exists = () => new Error(`${backup} already exists; refusing to overwrite it`);
  const lstatMissing = () => {
    try {
      fs.lstatSync(backup);
      return false;
    } catch (e) {
      if (e.code === 'ENOENT') return true;
      throw e;
    }
  };
  if (!lstatMissing()) throw exists();
  let mode = 0o600;
  try {
    mode = fs.statSync(src).mode & 0o777;
  } catch {}
  const data = fs.readFileSync(src);
  const tmpFile = path.join(path.dirname(backup), `.${path.basename(backup)}.zn-tmp.${process.pid}.${Date.now()}`);
  let created = false;
  try {
    fs.writeFileSync(tmpFile, data, { flag: 'wx', mode });
    created = true;
    try {
      fs.chmodSync(tmpFile, mode);
    } catch {}
    if (!lstatMissing()) throw exists();
    renameWithRetry(tmpFile, backup);
  } catch (err) {
    if (created) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
    throw err;
  }
}

/** Renames over target; on Windows-style sharing errors waits briefly and retries. */
function renameWithRetry(from, to) {
  const busy = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!busy.has(err.code)) throw err;
      if (attempt >= 5) {
        throw new Error(`could not replace ${to}: it is in use by another program; close it and run again`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    }
  }
}

/** "<file>.bak.<ms>" that does not exist yet (a revert right after a wrap can land in the same millisecond). */
function freeBackupName(filePath) {
  let n = Date.now();
  for (let i = 0; i < 100; i++, n++) {
    const candidate = `${filePath}.bak.${n}`;
    try {
      fs.lstatSync(candidate);
    } catch (e) {
      if (e.code === 'ENOENT') return candidate;
      throw e;
    }
  }
  return `${filePath}.bak.${n}`;
}

/**
 * Protects (or reverts) the detected environments.
 *
 * @param {object} options - { shadow: boolean, dryRun: boolean, revert: boolean, envList: array }
 */
function configureEnvironments(options = {}) {
  const envs = scanEnvironments(options.envList, options.projectDir);
  const actions = [];

  for (const env of envs) {
    if (!env.exists) continue;

    const resolved = resolveConfig(env.filePath, env.scope, options.projectDir);
    if (resolved.reason) {
      if (options.revert || env.serverCount > 0) {
        actions.push({ env: env.name, status: 'skipped_unsafe', file: env.filePath, error: `${env.filePath}: ${resolved.reason}; skipped` });
      }
      continue;
    }

    if (options.revert) {
      if (env.serverCount === 0) {
        const err = env.servers.find((s) => s.error);
        if (err) actions.push({ env: env.name, status: 'manual_required', error: err.error, file: env.filePath });
        continue;
      }
      try {
        const raw = fs.readFileSync(env.filePath, 'utf8');
        const { modified, content, count, manual } = adapterFor(env).unshield(raw, env);
        let backup;
        if (modified && !options.dryRun) {
          // The file is un-wrapped in place, so edits made after wrapping stay. A copy of the
          // file as it is now is saved first; earlier copies are never touched.
          backup = freeBackupName(env.filePath);
          createBackup(env.filePath, backup);
          atomicWrite(resolved.target, content);
        }
        if (modified) {
          actions.push({
            env: env.name,
            status: options.dryRun ? 'would_revert' : 'reverted',
            serversCount: count,
            ...(backup ? { backup } : {}),
            ...(manual.length ? { manual } : {}),
          });
        } else if (manual.length) {
          actions.push({ env: env.name, status: 'manual_required', manual, file: env.filePath });
        } else {
          actions.push({ env: env.name, status: 'nothing_to_revert' });
        }
      } catch (err) {
        actions.push({ env: env.name, status: err.manual ? 'manual_required' : 'error', error: err.message, file: env.filePath });
      }
      continue;
    }

    if (env.serverCount === 0) {
      const err = env.servers.find((s) => s.error);
      if (err) actions.push({ env: env.name, status: 'manual_required', error: err.error, file: env.filePath });
      continue;
    }

    try {
      const raw = fs.readFileSync(env.filePath, 'utf8');
      const { modified, content, manual } = adapterFor(env).shield(raw, env, options);

      let backup;
      if (modified && !options.dryRun) {
        backup = `${env.filePath}.bak.${Date.now()}`;
        createBackup(env.filePath, backup);
        atomicWrite(resolved.target, content);
      }

      if (modified) {
        actions.push({
          env: env.name,
          status: options.dryRun ? 'would_shield' : 'shielded',
          serversCount: env.serverCount,
          shadow: Boolean(options.shadow),
          ...(backup ? { backup } : {}),
          ...(manual.length ? { manual } : {}),
        });
      } else if (manual.length) {
        actions.push({ env: env.name, status: 'manual_required', manual, file: env.filePath });
      } else {
        actions.push({ env: env.name, status: 'already_shielded' });
      }
    } catch (err) {
      actions.push({ env: env.name, status: err.manual ? 'manual_required' : 'error', error: err.message, file: env.filePath });
    }
  }

  return { scanned: envs, actions };
}

module.exports = {
  getKnownEnvironments,
  scanEnvironments,
  configureEnvironments,
  // exported for tests
  resolveConfig,
  _internal: { scanCodexToml, parseTomlStringArray, parseTomlKeyPath },
};
