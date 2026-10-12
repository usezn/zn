'use strict';
/**
 * `zn audit`: static review of the agent configuration a repository ships.
 * Nothing is executed and nothing leaves the machine.
 *
 *   audit({ root, agents, includeHome, home, env }) -> { root, files, findings, truncated }
 *
 * Each finding: { id, severity, agent, file, line, title, detail, evidence,
 * fix, references }. `file` is relative to root (forward slashes), or starts
 * with "~/" for --include-home files. Evidence and detail go through the
 * scrubber, so secret values are never part of a finding.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonc, parseToml } = require('./parse');
const P = require('./patterns');
const { BY_ID, RANK } = require('./rules');

const AGENTS = ['claude', 'codex', 'cursor', 'opencode', 'amazonq', 'copilot', 'gemini'];
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 50000;
const EVIDENCE_MAX = 160;
const INSTRUCTION_READERS = ['codex', 'cursor', 'opencode', 'amazonq', 'copilot', 'gemini'];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'coverage', '.gradle',
  '.idea', 'Pods', 'bower_components', '.cache', 'site-packages', '.terraform', '.yarn', '.pnpm-store',
]);

/* ---------------------------- redaction ---------------------------- */

let scrubEngine = null;
function engine() {
  if (scrubEngine === null) {
    try { scrubEngine = require('../scrub/engine'); } catch (_) { scrubEngine = false; }
  }
  return scrubEngine || null;
}
let rulesLib = null;
function rules() {
  if (rulesLib === null) rulesLib = require('../rules');
  return rulesLib;
}

function secretSpans(text) {
  const e = engine();
  if (!e || !text) return [];
  try {
    return e.scan(text, { exact: false, pii: false });
  } catch (_) {
    return [];
  }
}

/** Text with every detected secret replaced by [REDACTED:<TYPE>]. */
function redact(text) {
  let s = String(text == null ? '' : text);
  const spans = secretSpans(s).sort((a, b) => b.start - a.start);
  for (const sp of spans) s = s.slice(0, sp.start) + '[REDACTED:' + sp.type + ']' + s.slice(sp.end);
  try { s = rules().redactSecrets(s).sanitized; } catch (_) { /* keep scrubber result */ }
  // Credentials in URLs (https://user:pass@host).
  s = s.replace(/(\b[a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@'"]{1,256}@/gi, '$1[REDACTED]@');
  return s;
}

function clip(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/* --------------------------- file context -------------------------- */

class FileCtx {
  constructor(rec, raw, out) {
    this.rec = rec;
    this.raw = raw;
    this.lines = raw.split(/\r?\n/);
    this.out = out;
  }

  /** 1-based line of the first occurrence of `needle` at or after line `from`. */
  find(needle, from) {
    if (needle == null || needle === '') return from || 1;
    const start = Math.max(0, (from || 1) - 1);
    for (let i = start; i < this.lines.length; i++) if (this.lines[i].includes(needle)) return i + 1;
    for (let i = 0; i < start; i++) if (this.lines[i].includes(needle)) return i + 1;
    return from || 1;
  }

  /** Line of a JSON key path (keys searched in order) and optional value. */
  locate(keys, value) {
    let line = 1;
    for (const k of keys) line = this.find(JSON.stringify(String(k)), line);
    if (value !== undefined && value !== null) {
      const v = JSON.stringify(String(value)).slice(1, -1).slice(0, 60);
      line = this.find(v, line);
    }
    return line;
  }

  add(id, severity, line, detail, extra) {
    const rule = BY_ID[id];
    const ln = Math.max(1, Math.min(line || 1, this.lines.length || 1));
    this.out.push({
      id,
      severity,
      agent: (extra && extra.agent) || this.rec.agent,
      file: this.rec.display,
      line: ln,
      title: (extra && extra.title) || rule.title,
      detail: clip(redact(detail), 600),
      evidence: clip(redact((extra && extra.evidence != null) ? extra.evidence : (this.lines[ln - 1] || '')), EVIDENCE_MAX),
      fix: (extra && extra.fix) || rule.fix,
      references: (extra && extra.references) || rule.references.slice(),
      _readers: (extra && extra.readers) || this.rec.readers,
    });
  }

  get home() { return this.rec.scope === 'home'; }
}

function capHome(ctx, severity) {
  if (!ctx.home) return severity;
  return RANK[severity] > RANK.medium ? 'medium' : severity;
}

/* ----------------------------- helpers ----------------------------- */

const OUR_HOOK = /(?:^|[\s"'/\\])zn(?:-gate)?(?:\.cmd|\.exe)?["']?\s+hook\s+[a-z-]+\s*$|hooks[\\/]runner\.js["']?\s+[a-z-]+\s*["']?\s*$/;

function isOurHook(command) {
  return typeof command === 'string' && OUR_HOOK.test(command.trim().replace(/"\s*$/, ''));
}

/** Every command string under a hooks tree: [{command, event}]. */
function hookCommands(tree) {
  const out = [];
  function walk(node, event, depth) {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, event, depth + 1); return; }
    if (typeof node !== 'object') return;
    for (const key of ['command', 'bash', 'powershell', 'commandWindows', 'windows', 'linux', 'osx']) {
      const v = node[key];
      if (typeof v === 'string' && v.trim()) out.push({ command: v, event });
      else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) out.push({ command: v.join(' '), event });
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') walk(v, event || k, depth + 1);
    }
  }
  walk(tree, null, 0);
  return out;
}

function checkDownloadRun(ctx, command, line, what) {
  const hit = P.downloadAndRun(command);
  if (!hit) return false;
  ctx.add('ZNA002', 'critical', line, what + ' downloads code and runs it: ' + clip(command, 200));
  return true;
}

function checkAutoRun(ctx, command, line, what) {
  checkDownloadRun(ctx, command, line, what);
  if (!ctx.home) ctx.add('ZNA001', 'high', line, what + ' runs automatically: ' + clip(command, 200));
}

function checkHooks(ctx, tree, keyPath) {
  for (const h of hookCommands(tree)) {
    if (isOurHook(h.command)) continue;
    const line = ctx.locate(keyPath.concat(h.event ? [h.event] : []), h.command);
    checkAutoRun(ctx, h.command, line, (h.event ? '"' + h.event + '" hook' : 'Hook'));
  }
}

function checkEnv(ctx, env, keyPath, opts) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const c = P.classifyEnv(k, v);
    if (!c) continue;
    const line = opts && opts.lineOf ? opts.lineOf(k) : ctx.locate(keyPath.concat([k]));
    if (c.kind === 'endpoint') {
      const sev = capHome(ctx, c.loopback ? 'medium' : 'critical');
      ctx.add('ZNA007', sev, line, k + ' points to ' + P.safeUrl(v) + (c.loopback ? ' (a local address)' : '') + '; the agent sends its API key and prompts there.');
    } else if (c.kind === 'proxy') {
      const sev = capHome(ctx, c.loopback ? 'medium' : 'high');
      ctx.add('ZNA007', sev, line, k + ' routes the agent\'s traffic through ' + (c.host || 'a proxy') + '.', { title: 'Agent traffic routed through a proxy set by the project' });
    } else {
      ctx.add('ZNA008', capHome(ctx, 'high'), line, k + ' is set for every process the agent starts.');
    }
  }
}

function endpointValue(ctx, key, value, line) {
  if (typeof value !== 'string' || P.isPlaceholder(value)) return;
  const host = P.hostOf(value);
  if (!host) return;
  const loop = P.isLoopback(host);
  ctx.add('ZNA007', capHome(ctx, loop ? 'medium' : 'critical'), line, key + ' points to ' + P.safeUrl(value) + (loop ? ' (a local address)' : '') + '; the agent sends its API key and prompts there.');
}

function isOurMcp(argv, ctx) {
  const words = argv.map(String);
  if (!words.includes('secrets-mcp')) return false;
  const tool = P.toolName(words[0]);
  if (tool === 'zn' || tool === 'zn-gate') return true;
  const cli = words.find((w) => /zn-gate[\\/]bin[\\/]cli\.js$/.test(w.replace(/\\/g, '/')) || /[\\/]cli\.js$/.test(w));
  if (!cli || !path.isAbsolute(cli)) return false;
  // A path inside the audited tree could be anything the repository ships.
  const rel = path.relative(ctx.rec.root, cli);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function mcpArgv(cfg) {
  if (Array.isArray(cfg.command)) return cfg.command.map(String);
  if (typeof cfg.command !== 'string' || !cfg.command.trim()) return null;
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  return args.length ? [cfg.command].concat(args) : P.splitCommand(cfg.command);
}

function checkMcpServers(ctx, servers, keyPath, opts) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  const o = opts || {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const line = o.lineOf ? o.lineOf(name) : ctx.locate(keyPath.concat([name]));
    if (cfg.disabled === true || cfg.enabled === false) continue;
    const argv = mcpArgv(cfg);
    if (argv && argv.length) {
      const cmd = argv.join(' ');
      if (!isOurMcp(argv, ctx)) {
        checkDownloadRun(ctx, cmd, line, 'MCP server "' + name + '"');
        if (!ctx.home) {
          const sev = o.severity || 'medium';
          ctx.add('ZNA003', sev, line, 'MCP server "' + name + '" runs: ' + clip(cmd, 200) + (o.note ? ' ' + o.note : ''));
        }
        for (const pkg of P.packagesOf(argv)) {
          if (!pkg.pinned) ctx.add('ZNA005', 'medium', line, 'MCP server "' + name + '" runs ' + pkg.spec + ' through ' + pkg.manager + ' without an exact version.');
        }
      }
    }
    const url = [cfg.url, cfg.httpUrl, cfg.serverUrl, cfg.endpoint].find((u) => typeof u === 'string' && u.trim());
    if (url && !P.isPlaceholder(url)) {
      const host = P.hostOf(url);
      if (host && !P.isLoopback(host)) {
        const plain = /^http:/i.test(url) || /^ws:/i.test(url);
        if (plain) ctx.add('ZNA006', 'medium', line, 'MCP server "' + name + '" uses unencrypted ' + P.safeUrl(url) + '.');
        else if (!ctx.home) ctx.add('ZNA006', 'low', line, 'MCP server "' + name + '" is remote: ' + P.safeUrl(url) + '.');
      }
    }
  }
}

/* ------------------------- per-kind checks ------------------------- */

const HELPER_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'gcpAuthRefresh'];

function checkClaudeSettings(ctx, data) {
  if (data.hooks && typeof data.hooks === 'object') checkHooks(ctx, data.hooks, ['hooks']);
  if (data.statusLine && typeof data.statusLine === 'object' && typeof data.statusLine.command === 'string') {
    checkAutoRun(ctx, data.statusLine.command, ctx.locate(['statusLine', 'command']), 'Status line command');
  }
  if (data.fileSuggestion && typeof data.fileSuggestion === 'object' && typeof data.fileSuggestion.command === 'string') {
    checkAutoRun(ctx, data.fileSuggestion.command, ctx.locate(['fileSuggestion', 'command']), 'File suggestion command');
  }
  for (const k of HELPER_KEYS) {
    if (typeof data[k] !== 'string' || !data[k].trim()) continue;
    const line = ctx.locate([k]);
    checkDownloadRun(ctx, data[k], line, k);
    if (!ctx.home) ctx.add('ZNA009', 'high', line, k + ' runs: ' + clip(data[k], 200));
  }
  checkEnv(ctx, data.env, ['env']);
  const perms = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
  if (Array.isArray(perms.allow)) {
    for (const entry of perms.allow) {
      const sev = P.claudePermission(entry);
      if (sev) ctx.add('ZNA010', capHome(ctx, sev), ctx.locate(['permissions', 'allow'], entry), 'permissions.allow contains ' + JSON.stringify(String(entry)) + ', which allows any command.');
    }
  }
  if (perms.defaultMode === 'bypassPermissions') {
    ctx.add('ZNA010', capHome(ctx, 'high'), ctx.locate(['permissions', 'defaultMode']), 'permissions.defaultMode is bypassPermissions: no prompts at all.');
  }
  if (data.skipDangerousModePermissionPrompt === true) {
    ctx.add('ZNA010', capHome(ctx, 'medium'), ctx.locate(['skipDangerousModePermissionPrompt']), 'skipDangerousModePermissionPrompt hides the warning before bypass mode.');
  }
  if (!ctx.home) {
    if (data.enableAllProjectMcpServers === true) {
      ctx.add('ZNA004', 'high', ctx.locate(['enableAllProjectMcpServers']), 'enableAllProjectMcpServers starts every server in .mcp.json without asking.');
    }
    if (Array.isArray(data.enabledMcpjsonServers) && data.enabledMcpjsonServers.length) {
      ctx.add('ZNA004', 'medium', ctx.locate(['enabledMcpjsonServers']), 'enabledMcpjsonServers approves ' + data.enabledMcpjsonServers.map(String).slice(0, 5).join(', ') + ' in advance.');
    }
    const plugins = data.enabledPlugins && typeof data.enabledPlugins === 'object' ? Object.keys(data.enabledPlugins).filter((k) => data.enabledPlugins[k]) : [];
    if (plugins.length) ctx.add('ZNA017', 'medium', ctx.locate(['enabledPlugins']), 'enabledPlugins turns on ' + plugins.slice(0, 5).join(', ') + '.');
    if (data.extraKnownMarketplaces && typeof data.extraKnownMarketplaces === 'object' && Object.keys(data.extraKnownMarketplaces).length) {
      ctx.add('ZNA017', 'medium', ctx.locate(['extraKnownMarketplaces']), 'extraKnownMarketplaces adds ' + Object.keys(data.extraKnownMarketplaces).slice(0, 5).join(', ') + ' as plugin sources.');
    }
  }
  if (data.mcpServers) checkMcpServers(ctx, data.mcpServers, ['mcpServers'], { severity: 'medium' });
}

function checkClaudeUserJson(ctx, data) {
  checkMcpServers(ctx, data.mcpServers, ['mcpServers']);
  if (data.projects && typeof data.projects === 'object') {
    for (const [proj, cfg] of Object.entries(data.projects)) {
      if (cfg && cfg.mcpServers) checkMcpServers(ctx, cfg.mcpServers, ['projects', proj, 'mcpServers']);
    }
  }
}

const MCP_SEVERITY = { amazonq: 'high', codex: 'high' };

function checkMcpJson(ctx, data) {
  const key = ctx.rec.kind === 'vscode-mcp' ? 'servers' : 'mcpServers';
  const sev = MCP_SEVERITY[ctx.rec.agent] || 'medium';
  const note = sev === 'high' ? '(' + (ctx.rec.agent === 'amazonq' ? 'Amazon Q' : 'Codex') + ' versions affected by ' + (ctx.rec.agent === 'amazonq' ? 'CVE-2026-12957' : 'CVE-2025-61260') + ' start it without asking.)' : '';
  checkMcpServers(ctx, data[key], [key], { severity: sev, note });
}

function tomlLineOf(lines, prefix) {
  return (k) => lines[prefix.concat([k]).join('.')] || lines[prefix.join('.')] || 1;
}

function checkCodexToml(ctx, data, lines) {
  if (data.mcp_servers && typeof data.mcp_servers === 'object') {
    checkMcpServers(ctx, data.mcp_servers, [], {
      severity: 'high',
      note: '(Codex versions affected by CVE-2025-61260 start it without asking.)',
      lineOf: tomlLineOf(lines, ['mcp_servers']),
    });
  }
  if (Array.isArray(data.notify) && data.notify.length) {
    checkAutoRun(ctx, data.notify.map(String).join(' '), lines.notify || 1, 'notify command');
  }
  const scopes = [{ cfg: data, prefix: [] }];
  if (data.profiles && typeof data.profiles === 'object') {
    for (const [name, p] of Object.entries(data.profiles)) if (p && typeof p === 'object') scopes.push({ cfg: p, prefix: ['profiles', name] });
  }
  for (const { cfg, prefix } of scopes) {
    const where = prefix.length ? ' (profile ' + prefix[1] + ')' : '';
    const never = cfg.approval_policy === 'never';
    const full = cfg.sandbox_mode === 'danger-full-access';
    const ln = lines[prefix.concat([full ? 'sandbox_mode' : 'approval_policy']).join('.')] || 1;
    if (never && full) ctx.add('ZNA010', capHome(ctx, 'high'), ln, 'approval_policy = "never" with sandbox_mode = "danger-full-access"' + where + ': any command, no prompt, no sandbox.');
    else if (full) ctx.add('ZNA010', capHome(ctx, 'medium'), ln, 'sandbox_mode = "danger-full-access"' + where + ' turns the sandbox off.');
    else if (never && !ctx.home) ctx.add('ZNA010', 'medium', ln, 'approval_policy = "never"' + where + ': commands run without a prompt.');
    for (const k of ['openai_base_url', 'chatgpt_base_url', 'experimental_base_url']) {
      if (typeof cfg[k] === 'string') endpointValue(ctx, k, cfg[k], lines[prefix.concat([k]).join('.')] || 1);
    }
  }
  if (data.model_providers && typeof data.model_providers === 'object') {
    for (const [name, p] of Object.entries(data.model_providers)) {
      if (p && typeof p.base_url === 'string') endpointValue(ctx, 'model_providers.' + name + '.base_url', p.base_url, lines['model_providers.' + name + '.base_url'] || lines['model_providers.' + name] || 1);
    }
  }
  const sep = data.shell_environment_policy;
  if (sep && sep.set && typeof sep.set === 'object') {
    checkEnv(ctx, sep.set, [], { lineOf: tomlLineOf(lines, ['shell_environment_policy', 'set']) });
  }
}

function checkHooksJson(ctx, data) {
  if (data.hooks && typeof data.hooks === 'object') checkHooks(ctx, data.hooks, ['hooks']);
}

function checkAmazonqAgent(ctx, data) {
  checkMcpServers(ctx, data.mcpServers, ['mcpServers'], { severity: 'high', note: '(Amazon Q versions affected by CVE-2026-12957 start it without asking.)' });
  if (data.hooks && typeof data.hooks === 'object') checkHooks(ctx, data.hooks, ['hooks']);
  if (Array.isArray(data.allowedTools)) {
    for (const t of data.allowedTools) {
      if (t === '*' || t === '@builtin' || t === 'execute_bash' || t === 'execute_cmd' || t === 'shell') {
        ctx.add('ZNA010', capHome(ctx, 'high'), ctx.locate(['allowedTools'], t), 'allowedTools contains ' + JSON.stringify(t) + ': shell commands run without a prompt.');
      }
    }
  }
}

function checkVscodeSettings(ctx, data) {
  for (const k of ['chat.tools.autoApprove', 'chat.tools.global.autoApprove']) {
    if (data[k] === true) ctx.add('ZNA010', capHome(ctx, 'high'), ctx.locate([k]), k + ' approves every tool call, terminal commands included.', { agent: 'copilot' });
  }
}

function checkVscodeTasks(ctx, data) {
  if (!Array.isArray(data.tasks)) return;
  for (const t of data.tasks) {
    if (!t || typeof t !== 'object' || !t.runOptions || t.runOptions.runOn !== 'folderOpen') continue;
    const argv = [t.command].concat(Array.isArray(t.args) ? t.args : []).filter((x) => typeof x === 'string');
    const cmd = argv.join(' ') || String(t.label || 'task');
    checkAutoRun(ctx, cmd, ctx.locate(['runOn'], 'folderOpen'), 'Task "' + String(t.label || '?') + '" (runOn: folderOpen)');
  }
}

function checkCursorCli(ctx, data) {
  const allow = data.permissions && Array.isArray(data.permissions.allow) ? data.permissions.allow : [];
  for (const entry of allow) {
    const sev = P.claudePermission(entry);
    if (sev) ctx.add('ZNA010', capHome(ctx, sev), ctx.locate(['permissions', 'allow'], entry), 'permissions.allow contains ' + JSON.stringify(String(entry)) + ', which allows any command.');
  }
}

function checkGeminiSettings(ctx, data) {
  checkMcpServers(ctx, data.mcpServers, ['mcpServers']);
  if (data.hooks && typeof data.hooks === 'object') checkHooks(ctx, data.hooks, ['hooks']);
  const allowed = data.tools && Array.isArray(data.tools.allowed) ? data.tools.allowed : (Array.isArray(data.coreToolsAllowed) ? data.coreToolsAllowed : []);
  for (const t of allowed) {
    if (t === 'run_shell_command' || t === 'ShellTool' || t === '*') ctx.add('ZNA010', capHome(ctx, 'high'), ctx.locate(['allowed'], t), 'The shell tool is allowed without a prompt.');
  }
}

function checkOpencodeJson(ctx, data) {
  if (data.mcp && typeof data.mcp === 'object') checkMcpServers(ctx, data.mcp, ['mcp']);
  const perm = data.permission;
  const bash = perm && typeof perm === 'object' ? perm.bash : undefined;
  if (perm === 'allow' || (perm && perm['*'] === 'allow')) {
    ctx.add('ZNA010', capHome(ctx, 'high'), ctx.locate(['permission']), 'permission allows every tool without a prompt.');
  } else if (bash === 'allow' || (bash && typeof bash === 'object' && bash['*'] === 'allow')) {
    ctx.add('ZNA010', capHome(ctx, 'high'), ctx.locate(['permission', 'bash']), 'permission.bash allows every command without a prompt.');
  }
  if (Array.isArray(data.plugin) && data.plugin.length) {
    const npm = data.plugin.filter((p) => typeof p === 'string' && P.npmSpec(p));
    if (npm.length && !ctx.home) ctx.add('ZNA017', 'medium', ctx.locate(['plugin']), 'OpenCode loads the npm plugins ' + npm.slice(0, 5).join(', ') + ' at start.');
    for (const p of npm) {
      if (!P.pinnedNpm(P.npmSpec(p).version)) ctx.add('ZNA005', 'medium', ctx.locate(['plugin'], p), 'Plugin ' + p + ' has no exact version.');
    }
  }
  if (Array.isArray(data.instructions)) {
    for (const ins of data.instructions) {
      if (typeof ins !== 'string' || !/^https?:\/\//i.test(ins)) continue;
      const plain = /^http:/i.test(ins);
      if (plain || !ctx.home) ctx.add('ZNA006', plain ? 'medium' : 'low', ctx.locate(['instructions'], ins), 'Instructions are loaded from ' + P.safeUrl(ins) + ' and can change after review.', { title: 'Agent instructions loaded from a URL' });
    }
  }
  if (data.provider && typeof data.provider === 'object') {
    for (const [name, p] of Object.entries(data.provider)) {
      const url = p && p.options && (p.options.baseURL || p.options.baseUrl);
      if (typeof url === 'string') endpointValue(ctx, 'provider.' + name + '.options.baseURL', url, ctx.locate(['provider', name, 'baseURL']));
    }
  }
}

function checkClaudePlugin(ctx, data) {
  if (data.hooks && typeof data.hooks === 'object') checkHooks(ctx, data.hooks, ['hooks']);
  if (data.mcpServers && typeof data.mcpServers === 'object') checkMcpServers(ctx, data.mcpServers, ['mcpServers']);
}

function checkDotenv(ctx) {
  ctx.lines.forEach((l, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
    if (!m) return;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    checkEnv(ctx, { [m[1]]: value }, [], { lineOf: () => i + 1 });
  });
}

function checkOpencodePlugin(ctx) {
  ctx.add('ZNA001', 'high', 1, 'OpenCode loads ' + path.basename(ctx.rec.abs) + ' as a plugin and runs it at start.', { evidence: ctx.lines.find((l) => l.trim()) || '' });
  ctx.lines.forEach((l, i) => { checkDownloadRun(ctx, l, i + 1, 'The plugin'); });
}

/* ------------------------- instruction files ------------------------ */

const INVISIBLE = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;
const INVISIBLE_ALL = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
// Rules tuned for prompts that are too noisy in documentation ("act as",
// "never print tokens", mentions of .env): left to ZNA011 and ZNA014.
const NOISY_IN_DOCS = /^(?:secret|path):|^exfil:credentials$|^pi:(?:act_as|pretend|roleplay|bypass)$/;

function checkInstructions(ctx) {
  const claudeExt = /(^|\/)\.claude\/(commands|agents|skills)\//.test(ctx.rec.rel);
  let inFront = ctx.lines[0] && ctx.lines[0].trim() === '---';
  ctx.lines.forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.length > P.MAX_LINE ? raw.slice(0, P.MAX_LINE) : raw;
    if (inFront && i > 0 && line.trim() === '---') inFront = false;
    if (inFront && claudeExt) {
      const m = /^\s*(?:allowed-tools|tools)\s*:\s*(.*)$/.exec(line) || /^\s*-\s*(.+)$/.exec(line);
      if (m) {
        for (const entry of m[1].replace(/^\[|\]$/g, '').split(/,(?![^(]*\))/)) {
          const e = entry.trim().replace(/^["']|["']$/g, '');
          if (e && P.claudePermission(e)) ctx.add('ZNA010', 'high', ln, 'The extension allows ' + JSON.stringify(e) + ' without a prompt.');
        }
      }
    }
    const t = line.trim();
    if (t.length < 8) return;
    if (INVISIBLE.test(line)) {
      ctx.add('ZNA012', 'high', ln, 'The line contains invisible Unicode (tag or bidirectional control characters) that can hide text from reviewers.', { evidence: line.replace(INVISIBLE_ALL, '?') });
    } else {
      let res = null;
      try { res = rules().evaluate(t); } catch (_) { res = null; }
      if (res && res.verdict === 'block' && !NOISY_IN_DOCS.test(String(res.rule))) {
        ctx.add('ZNA012', 'high', ln, 'Rules engine: ' + (res.reason || res.rule) + '.');
      }
    }
    const dl = P.downloadAndRun(t, { prose: true });
    if (dl) ctx.add('ZNA013', dl.knownInstaller ? 'low' : 'medium', ln, (dl.knownInstaller ? 'A well-known installer is piped into a shell: ' : 'The instructions pipe a download into a shell: ') + clip(dl.match, 160));
    const ex = P.exfiltration(t);
    if (ex) ctx.add('ZNA014', 'high', ln, 'The instructions send sensitive material out: ' + clip(ex, 160));
    const wk = P.weakening(t);
    if (wk) ctx.add('ZNA015', 'medium', ln, 'The instructions weaken a safety check: ' + clip(wk, 120));
  });
}

/* ---------------------------- workflows ----------------------------- */

const CI_AGENT_ACTIONS = [
  [/anthropics\/claude-code(?:-base)?-action@/i, 'claude'],
  [/google-github-actions\/run-gemini-cli@/i, 'gemini'],
  [/openai\/codex-action@/i, 'codex'],
  [/(?:sst|anomalyco)\/opencode[\w/-]*@/i, 'opencode'],
  [/aws-actions\/[\w-]*amazon-q[\w-]*@/i, 'amazonq'],
  [/github\/copilot[\w-]*@/i, 'copilot'],
];
const CI_AGENT_RUN = [
  [/\bclaude\s+(?:-p|--print)\b/, 'claude'],
  [/\bcodex\s+exec\b/, 'codex'],
  [/\bgemini\s+(?:-p|--prompt)\b/, 'gemini'],
  [/\bopencode\s+run\b/, 'opencode'],
  [/\bq\s+chat\s+--no-interactive\b/, 'amazonq'],
];
const UNTRUSTED_TRIGGERS = ['issue_comment', 'issues', 'pull_request_target', 'pull_request_review_comment', 'pull_request_review', 'discussion', 'discussion_comment'];

function checkWorkflow(ctx) {
  let agentLine = 0;
  let agent = null;
  ctx.lines.forEach((l, i) => {
    if (agent) return;
    if (/^\s*#/.test(l)) return;
    for (const [re, a] of CI_AGENT_ACTIONS) if (/\buses\s*:/.test(l) && re.test(l)) { agent = a; agentLine = i + 1; return; }
    for (const [re, a] of CI_AGENT_RUN) if (re.test(l)) { agent = a; agentLine = i + 1; return; }
  });
  if (!agent) return;
  const jobsAt = ctx.lines.findIndex((l) => /^jobs\s*:/.test(l));
  const head = (jobsAt < 0 ? ctx.lines : ctx.lines.slice(0, jobsAt)).filter((l) => !/^\s*#/.test(l)).join('\n');
  const triggers = UNTRUSTED_TRIGGERS.filter((t) => new RegExp('(?:^|[\\s\\[,])' + t + '(?:\\s*:|\\s*[,\\]]|\\s*$)', 'm').test(head));
  if (!triggers.length) return;
  const text = ctx.lines.filter((l) => !/^\s*#/.test(l)).join('\n');
  const prt = triggers.includes('pull_request_target');
  const write = /permissions\s*:\s*write-all\b/.test(text) || /^\s*(?:contents|pull-requests|issues|actions|packages|id-token|deployments|statuses|checks)\s*:\s*write\b/m.test(text);
  const interpolated = /\$\{\{\s*github\.event\.(?:issue|comment|pull_request|review|discussion)\.(?:body|title)\b/.test(text);
  const authorFilter = /author_association|github\.actor\s*==|github\.event\.(?:comment|issue|sender)\.user\.login\s*==/.test(text);
  let severity = 'medium';
  if (prt || interpolated || (write && !authorFilter)) severity = 'high';
  const why = [];
  why.push('triggered by ' + triggers.join(', '));
  if (prt) why.push('pull_request_target runs with the base repository\'s secrets');
  if (write) why.push('the workflow has write permissions');
  if (interpolated) why.push('issue or comment text is pasted into the workflow');
  if (authorFilter) why.push('an author filter is present');
  ctx.add('ZNA019', severity, agentLine, 'An AI agent (' + agent + ') runs on input from outside the team: ' + why.join('; ') + '.', { agent, readers: [agent] });
}

/* ---------------------------- discovery ----------------------------- */

function rule(kind, agent, readers) {
  return { kind, agent, readers: readers || [agent] };
}

/** Classify a project file by its path relative to the root (forward slashes). */
function classify(rel, isRootLevel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  const has = (re) => re.test(rel);
  if (has(/(^|\/)\.claude\/settings(\.local)?\.json$/)) return rule('claude-settings', 'claude', ['claude', 'cursor']);
  if (base === '.mcp.json') return rule('mcp-json', 'claude');
  if (has(/(^|\/)\.cursor\/mcp\.json$/)) return rule('mcp-json', 'cursor');
  if (has(/(^|\/)\.amazonq\/(?:default\.)?mcp\.json$/)) return rule('mcp-json', 'amazonq');
  if (has(/(^|\/)\.amazonq\/(?:cli-)?agents\/[^/]+\.json$/)) return rule('amazonq-agent', 'amazonq');
  if (has(/(^|\/)\.vscode\/mcp\.json$/)) return rule('vscode-mcp', 'copilot', ['copilot', 'cursor']);
  if (has(/(^|\/)\.vscode\/settings\.json$/)) return rule('vscode-settings', 'copilot', ['copilot', 'cursor']);
  if (has(/(^|\/)\.vscode\/tasks\.json$/)) return rule('vscode-tasks', 'cursor', ['cursor', 'copilot']);
  if (has(/(^|\/)\.codex\/config\.toml$/)) return rule('codex-toml', 'codex');
  if (has(/(^|\/)\.codex\/hooks\.json$/)) return rule('hooks-json', 'codex');
  if (has(/(^|\/)\.cursor\/hooks\.json$/)) return rule('hooks-json', 'cursor');
  if (has(/(^|\/)\.cursor\/cli\.json$/)) return rule('cursor-cli', 'cursor');
  if (has(/(^|\/)\.gemini\/settings\.json$/)) return rule('gemini-settings', 'gemini');
  if (/^opencode\.jsonc?$/.test(base) && (isRootLevel || has(/(^|\/)\.opencode\/opencode\.jsonc?$/) || !rel.includes('/'))) return rule('opencode-json', 'opencode');
  if (has(/(^|\/)\.opencode\/plugins?\/[^/]+\.(?:js|mjs|cjs|ts|mts)$/)) return rule('opencode-plugin', 'opencode');
  if (has(/(^|\/)\.claude-plugin\/plugin\.json$/)) return rule('claude-plugin', 'claude');
  if (has(/(^|\/)\.claude-plugin\/marketplace\.json$/)) return rule('config-other', 'claude');
  if (has(/(^|\/)hooks\/hooks\.json$/)) return rule('plugin-hooks', 'claude');
  if (base === '.env' && isRootLevel) return rule('dotenv', 'codex');
  if (has(/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/)) return rule('workflow', 'any', AGENTS);
  // Instruction files.
  if (base === 'AGENTS.md' || base === 'AGENTS.override.md') return rule('instructions', 'any', INSTRUCTION_READERS);
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') return rule('instructions', 'claude');
  if (base === 'GEMINI.md') return rule('instructions', 'gemini');
  if (base === '.cursorrules') return rule('instructions', 'cursor');
  if (base === '.windsurfrules') return rule('instructions', 'any', AGENTS);
  if (has(/(^|\/)\.clinerules(\/|$)/)) return rule('instructions', 'any', AGENTS);
  if (has(/(^|\/)\.github\/copilot-instructions\.md$/) || has(/(^|\/)\.github\/(?:instructions|prompts|agents|chatmodes)\/.+\.md$/)) return rule('instructions', 'copilot');
  if (has(/(^|\/)\.cursor\/(?:rules|commands|agents)\/.+\.(?:mdc|md)$/)) return rule('instructions', 'cursor');
  if (has(/(^|\/)\.claude\/(?:commands|agents|skills|output-styles)\/.+\.md$/)) return rule('instructions', 'claude');
  if (has(/(^|\/)\.codex\/prompts\/.+\.md$/)) return rule('instructions', 'codex');
  if (has(/(^|\/)\.opencode\/(?:commands?|agents?)\/.+\.md$/)) return rule('instructions', 'opencode');
  if (has(/(^|\/)\.amazonq\/rules\/.+\.md$/)) return rule('instructions', 'amazonq');
  if (has(/(^|\/)\.gemini\/commands\/.+\.toml$/)) return rule('instructions', 'gemini');
  if (lower === 'skill.md' && has(/(^|\/)skills\//)) return rule('instructions', 'claude');
  return null;
}

const EXTENSION_DIRS = [
  [/(^|\/)\.claude\/commands$/, 'claude', 'slash commands'],
  [/(^|\/)\.claude\/agents$/, 'claude', 'subagents'],
  [/(^|\/)\.claude\/skills$/, 'claude', 'skills'],
  [/(^|\/)\.claude-plugin$/, 'claude', 'a plugin'],
  [/(^|\/)\.codex\/prompts$/, 'codex', 'prompts'],
  [/(^|\/)\.cursor\/commands$/, 'cursor', 'commands'],
  [/(^|\/)\.opencode\/commands?$/, 'opencode', 'commands'],
  [/(^|\/)\.opencode\/agents?$/, 'opencode', 'agents'],
  [/(^|\/)\.opencode\/plugins?$/, 'opencode', 'plugins'],
  [/(^|\/)\.gemini\/commands$/, 'gemini', 'commands'],
  [/(^|\/)\.github\/(?:prompts|agents|chatmodes)$/, 'copilot', 'prompts or agents'],
  [/(^|\/)\.amazonq\/(?:cli-)?agents$/, 'amazonq', 'agents'],
];

function walk(root) {
  const files = [];
  const extDirs = [];
  let entries = 0;
  let truncated = false;
  function visit(dir, rel, depth) {
    if (truncated) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of list) {
      if (++entries > MAX_ENTRIES) { truncated = true; return; }
      const r = rel ? rel + '/' + d.name : d.name;
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        const ext = EXTENSION_DIRS.find(([re]) => re.test(r));
        if (ext) extDirs.push({ rel: r, abs, agent: ext[1], what: ext[2] });
        if (depth < MAX_DEPTH) visit(abs, r, depth + 1);
      } else if (d.isFile()) {
        const c = classify(r, !rel);
        if (c) files.push(Object.assign({ abs, rel: r, display: r, scope: 'project' }, c));
      }
    }
  }
  visit(root, '', 0);
  return { files, extDirs, truncated };
}

function homeFiles(home, env) {
  const xdg = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const list = [
    [path.join(home, '.claude', 'settings.json'), 'claude-settings', 'claude'],
    [path.join(home, '.claude.json'), 'claude-user-json', 'claude'],
    [path.join(codexHome, 'config.toml'), 'codex-toml', 'codex'],
    [path.join(codexHome, 'hooks.json'), 'hooks-json', 'codex'],
    [path.join(home, '.cursor', 'mcp.json'), 'mcp-json', 'cursor'],
    [path.join(home, '.cursor', 'hooks.json'), 'hooks-json', 'cursor'],
    [path.join(home, '.aws', 'amazonq', 'mcp.json'), 'mcp-json', 'amazonq'],
    [path.join(xdg, 'opencode', 'opencode.json'), 'opencode-json', 'opencode'],
    [path.join(xdg, 'opencode', 'opencode.jsonc'), 'opencode-json', 'opencode'],
    [path.join(home, '.gemini', 'settings.json'), 'gemini-settings', 'gemini'],
  ];
  return list.map(([abs, kind, agent]) => {
    const rel = path.relative(home, abs).split(path.sep).join('/');
    const display = rel.startsWith('..') || path.isAbsolute(rel) ? abs.split(path.sep).join('/') : '~/' + rel;
    return { abs, rel, display, kind, agent, readers: [agent], scope: 'home' };
  });
}

/** Paths the root .gitignore ignores, for the few files only worth reporting when committed. */
function gitIgnored(root, name) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch (_) { return false; }
  let ignored = false;
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const neg = t.startsWith('!');
    const pat = (neg ? t.slice(1) : t).replace(/^\//, '').replace(/\/$/, '');
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    if (re.test(name)) ignored = !neg;
  }
  return ignored;
}

/* ----------------------- shadowing executables ---------------------- */

function readHead(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0);
    return b.slice(0, n);
  } catch (_) {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

function checkShadowing(root, out) {
  let list;
  try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const d of list) {
    if (!d.isFile() && !d.isSymbolicLink()) continue;
    const name = d.name;
    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    const stem = ext ? lower.slice(0, -ext.length) : lower;
    if (!P.SHADOWED_TOOLS.has(stem)) continue;
    let severity = null;
    let why = '';
    const abs = path.join(root, name);
    if (P.WINDOWS_EXEC_EXT.has(ext)) {
      severity = 'critical';
      why = 'Windows runs ' + name + ' from the current directory before the real ' + stem + '.';
    } else if (!ext || ext === '.sh') {
      if (d.isSymbolicLink()) {
        severity = 'high';
        why = name + ' is a symbolic link named like the ' + stem + ' tool.';
      } else {
        let st;
        try { st = fs.statSync(abs); } catch (_) { continue; }
        const head = readHead(abs);
        const binary = head.length >= 2 && ((head[0] === 0x4d && head[1] === 0x5a) || (head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') || head.readUInt32BE(0) === 0xcffaedfe || head.readUInt32BE(0) === 0xfeedfacf);
        const script = head.toString('latin1', 0, 2) === '#!';
        const execBit = process.platform !== 'win32' && (st.mode & 0o111) !== 0;
        if (binary || ((script || execBit) && !ext)) {
          severity = 'high';
          why = name + ' is ' + (binary ? 'a native executable' : 'an executable script') + ' named like the ' + stem + ' tool; any tool that searches the current directory or a PATH that includes it runs this file.';
        }
      }
    }
    if (!severity) continue;
    out.push({
      id: 'ZNA016', severity, agent: 'any', file: name, line: 1,
      title: BY_ID.ZNA016.title, detail: why, evidence: name,
      fix: BY_ID.ZNA016.fix, references: BY_ID.ZNA016.references.slice(), _readers: AGENTS,
    });
  }
}

/* ------------------------------ audit ------------------------------- */

const CHECKS = {
  'claude-settings': checkClaudeSettings,
  'claude-user-json': checkClaudeUserJson,
  'mcp-json': checkMcpJson,
  'vscode-mcp': checkMcpJson,
  'amazonq-agent': checkAmazonqAgent,
  'vscode-settings': checkVscodeSettings,
  'vscode-tasks': checkVscodeTasks,
  'hooks-json': checkHooksJson,
  'plugin-hooks': checkHooksJson,
  'cursor-cli': checkCursorCli,
  'gemini-settings': checkGeminiSettings,
  'opencode-json': checkOpencodeJson,
  'claude-plugin': checkClaudePlugin,
  'config-other': () => {},
};

function auditFile(rec, out) {
  let st;
  try { st = fs.statSync(rec.abs); } catch (_) { return false; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
  let raw;
  try { raw = fs.readFileSync(rec.abs, 'utf8'); } catch (_) { return false; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const ctx = new FileCtx(rec, raw, out);

  if (rec.kind === 'plugin-hooks') {
    // Only a hooks.json that belongs to a Claude Code plugin.
    const pluginRoot = path.dirname(path.dirname(rec.abs));
    if (!fs.existsSync(path.join(pluginRoot, '.claude-plugin'))) return false;
  }
  if (rec.kind === 'dotenv') {
    if (gitIgnored(rec.root, '.env')) return false;
    checkDotenv(ctx);
    return true;
  }
  if (rec.kind === 'instructions') {
    checkSecrets(ctx);
    checkInstructions(ctx);
    return true;
  }
  if (rec.kind === 'workflow') {
    checkWorkflow(ctx);
    return true;
  }
  if (rec.kind === 'opencode-plugin') {
    if (path.basename(rec.abs) === 'zn-gate.js' && /zn-gate|\bzn hook\b/.test(raw)) return true;
    checkSecrets(ctx);
    checkOpencodePlugin(ctx);
    return true;
  }
  checkSecrets(ctx);
  if (rec.kind === 'codex-toml') {
    let parsed;
    try { parsed = parseToml(raw); } catch (err) {
      ctx.add('ZNA020', 'low', err.line || 1, 'TOML error: ' + err.message);
      return true;
    }
    checkCodexToml(ctx, parsed.data, parsed.lines);
    return true;
  }
  if (!raw.trim()) return true;
  let data;
  try { data = parseJsonc(raw); } catch (err) {
    ctx.add('ZNA020', 'low', err.line || 1, 'JSON error: ' + err.message);
    return true;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return true;
  const fn = CHECKS[rec.kind];
  if (fn) fn(ctx, data);
  return true;
}

function checkSecrets(ctx) {
  const spans = secretSpans(ctx.raw);
  if (!spans.length) return;
  const seen = new Set();
  let offset = 0;
  const starts = ctx.lines.map((l) => { const s = offset; offset += l.length + 1; return s; });
  for (const sp of spans) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= sp.start) lo = mid; else hi = mid - 1; }
    const key = lo + ':' + sp.type;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.add('ZNA011', 'high', lo + 1, 'A ' + sp.type + ' value is stored in the file.');
  }
}

function inventory(extDirs, out) {
  for (const d of extDirs) {
    let first = null;
    let count = 0;
    (function scan(dir, rel, depth) {
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of list) {
        if (e.isSymbolicLink()) continue;
        if (e.isFile()) { count++; if (!first) first = rel + '/' + e.name; } else if (e.isDirectory() && depth < 4) scan(path.join(dir, e.name), rel + '/' + e.name, depth + 1);
      }
    })(d.abs, d.rel, 0);
    if (!count) continue;
    out.push({
      id: 'ZNA018', severity: 'low', agent: d.agent, file: first, line: 1,
      title: BY_ID.ZNA018.title,
      detail: d.rel + ' adds ' + d.what + ' to ' + d.agent + ' (' + count + ' file' + (count === 1 ? '' : 's') + ').',
      evidence: d.rel, fix: BY_ID.ZNA018.fix, references: [], _readers: [d.agent],
    });
  }
}

function normalizeAgents(list) {
  if (!list || list.length === 0 || list.includes('all')) return new Set(AGENTS);
  return new Set(list);
}

function audit(opts) {
  const o = opts || {};
  const root = path.resolve(o.root || '.');
  const selected = normalizeAgents(o.agents);
  const env = o.env || process.env;
  const out = [];
  const { files, extDirs, truncated } = walk(root);
  let scanned = 0;
  const wanted = (readers, agent) => agent === 'any' || (readers || []).some((r) => selected.has(r)) || selected.has(agent);
  for (const rec of files) {
    rec.root = root;
    if (rec.kind !== 'workflow' && !wanted(rec.readers, rec.agent)) continue;
    if (auditFile(rec, out)) scanned++;
  }
  if (o.includeHome) {
    const home = o.home || os.homedir();
    for (const rec of homeFiles(home, env)) {
      rec.root = root;
      if (!wanted(rec.readers, rec.agent)) continue;
      if (!fs.existsSync(rec.abs)) continue;
      if (auditFile(rec, out)) scanned++;
    }
  }
  checkShadowing(root, out);
  inventory(extDirs, out);

  const seen = new Set();
  const findings = [];
  for (const f of out) {
    if (!(f.agent === 'any' || selected.has(f.agent) || (f._readers || []).some((r) => selected.has(r)))) continue;
    const key = [f.id, f.file, f.line, f.severity, f.detail].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    delete f._readers;
    findings.push(f);
  }
  findings.sort((a, b) => (RANK[b.severity] - RANK[a.severity]) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line - b.line) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { root, files: scanned, findings, truncated, agents: Array.from(selected) };
}

module.exports = { audit, classify, redact, AGENTS, _internal: { hookCommands, isOurHook, gitIgnored } };
