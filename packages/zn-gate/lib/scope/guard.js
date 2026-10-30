'use strict';

/*
 * Scope guard (spike): a deterministic check that a tool call stays inside a written scope, deny by default.
 *
 * The scope file is JSON (a YAML reader would need a dependency). The guard is off while no scope file is configured
 * (config hooks.scopeFile in ~/.zn/config.json: agents cannot write there). Once one is configured, anything the guard
 * cannot read, parse or resolve is refused (or asked, rules.unresolved = "ask"): a missing, unreadable, malformed or
 * changed scope file refuses every tool call.
 *
 *   {
 *     "version": 1,
 *     "targets": {
 *       "hosts": ["app.example.com", "*.lab.test"],      // exact or "*.suffix" (suffix only, not the bare domain)
 *       "cidrs": ["192.0.2.0/24"],                        // IPv4
 *       "url_prefixes": ["https://api.example.com/v1/"],  // a URL under one of these is in scope on its own
 *       "mcp_servers": ["lab-notes"]
 *     },
 *     "rules": {
 *       "allowed_tools": ["bash", "webfetch", "read"],    // tool names as the engine sees them; "mcp" is governed by mcp_servers
 *       "allowed_mcp_tools": ["lab-notes/search"],        // optional: "server/tool" or "server/*"
 *       "time_window": { "not_before": "2026-11-01T00:00:00Z", "not_after": "2026-11-02T00:00:00Z" },
 *       "max_requests": 50,                               // network requests across calls, counted in a state file
 *       "follow_redirects": false,                        // curl -L, wget without --max-redirect=0
 *       "unresolved": "deny"                              // "deny" (default) or "ask"
 *     }
 *   }
 *
 * What it can resolve: URLs, hosts, IPv4 (decimal, hex and octal spellings are normalised), CIDRs and nested URLs in a
 * query string, in the arguments of curl and wget, of the common network programs (nc, ssh, ping, nmap, ...), of inline
 * code, of a WebFetch call and of an MCP call; shell code inside sh -c; and the text of a script the agent runs by path
 * (one level, no imports). What it cannot resolve is refused as "unresolved": a target built at run time (a variable,
 * a command substitution, a format string, an environment variable, decoded text), code that arrives on standard input,
 * a script that is missing, binary or too big, a redirect that a program would follow, and a bare host name written
 * without a scheme inside a query string. Nothing here runs a command: the guard only reads text.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const policy = require('../hooks/policy');

const SCRIPT_MAX_BYTES = 256 * 1024;
const COMMANDS_MAX = 64;
const SHELL_CODE_DEPTH = 3;
const TOP_KEYS = new Set(['version', 'targets', 'rules']);
const TARGET_KEYS = new Set(['hosts', 'cidrs', 'url_prefixes', 'mcp_servers']);
const RULE_KEYS = new Set(['allowed_tools', 'allowed_mcp_tools', 'time_window', 'max_requests', 'follow_redirects', 'unresolved']);

/* ------------------------------- the scope file ------------------------------- */

function ipv4Of(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text));
  if (!m) return null;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) return null;
  return ((n[0] * 256 + n[1]) * 256 + n[2]) * 256 + n[3];
}

function cidrOf(text) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(text));
  if (!m) return null;
  const base = ipv4Of(m[1]);
  const bits = Number(m[2]);
  if (base === null || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

const HOST_PATTERN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function strings(value, what, errors, re) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) { errors.push(what + ' must be a list of text'); return []; }
  if (re) for (const v of value) if (!re.test(v)) errors.push(what + ' has an entry that is not valid: ' + JSON.stringify(v.slice(0, 40)));
  return value;
}

/** Reads and validates a scope file. Returns {ok, scope, sha256} or {ok:false, error, sha256?}; never throws. */
function loadScope(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { ok: false, error: 'the scope file cannot be read (' + (e.code || 'error') + ')' }; }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (buf.length > 256 * 1024) return { ok: false, sha256, error: 'the scope file is too large' };
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch (_) { return { ok: false, sha256, error: 'the scope file is not valid JSON' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, sha256, error: 'the scope file is not an object' };
  const errors = [];
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) errors.push('unknown key ' + JSON.stringify(k.slice(0, 40)));
  if (doc.version !== 1) errors.push('version must be 1');
  const t = doc.targets;
  const r = doc.rules;
  if (!t || typeof t !== 'object' || Array.isArray(t)) errors.push('targets is required');
  if (!r || typeof r !== 'object' || Array.isArray(r)) errors.push('rules is required');
  if (errors.length) return { ok: false, sha256, error: errors.join('; ') };
  for (const k of Object.keys(t)) if (!TARGET_KEYS.has(k)) errors.push('unknown targets key ' + JSON.stringify(k.slice(0, 40)));
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) errors.push('unknown rules key ' + JSON.stringify(k.slice(0, 40)));
  const hosts = strings(t.hosts, 'targets.hosts', errors, HOST_PATTERN_RE).map((h) => h.toLowerCase());
  const cidrs = strings(t.cidrs, 'targets.cidrs', errors).map((c) => { const p = cidrOf(c); if (!p) errors.push('targets.cidrs has an entry that is not an IPv4 CIDR'); return p; });
  const prefixes = strings(t.url_prefixes, 'targets.url_prefixes', errors).map((u) => {
    try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw new Error('scheme'); return p; } catch (_) { errors.push('targets.url_prefixes has an entry that is not an http(s) URL'); return null; }
  });
  const mcpServers = strings(t.mcp_servers, 'targets.mcp_servers', errors, /^[A-Za-z0-9._-]{1,64}$/);
  const tools = strings(r.allowed_tools, 'rules.allowed_tools', errors, /^[a-z][a-z0-9_]{0,31}$/);
  const mcpTools = r.allowed_mcp_tools === undefined ? null : strings(r.allowed_mcp_tools, 'rules.allowed_mcp_tools', errors, /^[A-Za-z0-9._-]{1,64}\/(?:\*|[A-Za-z0-9._-]{1,64})$/);
  let window = null;
  if (r.time_window !== undefined) {
    const w = r.time_window;
    const nb = w && typeof w.not_before === 'string' ? Date.parse(w.not_before) : NaN;
    const na = w && typeof w.not_after === 'string' ? Date.parse(w.not_after) : NaN;
    if (!w || Number.isNaN(nb) || Number.isNaN(na) || na <= nb) errors.push('rules.time_window needs not_before and not_after (ISO dates, in order)');
    else window = { notBefore: nb, notAfter: na };
  }
  if (r.max_requests !== undefined && !(Number.isInteger(r.max_requests) && r.max_requests >= 0)) errors.push('rules.max_requests must be a whole number');
  if (r.follow_redirects !== undefined && typeof r.follow_redirects !== 'boolean') errors.push('rules.follow_redirects must be true or false');
  if (r.unresolved !== undefined && r.unresolved !== 'deny' && r.unresolved !== 'ask') errors.push('rules.unresolved must be "deny" or "ask"');
  if (!hosts.length && !cidrs.length && !prefixes.length && !mcpServers.length) errors.push('targets lists nothing');
  if (errors.length) return { ok: false, sha256, error: errors.slice(0, 4).join('; ') };
  return {
    ok: true,
    sha256,
    scope: {
      hosts, cidrs, prefixes, mcpServers, tools: new Set(tools), mcpTools, window,
      maxRequests: r.max_requests === undefined ? null : r.max_requests,
      followRedirects: r.follow_redirects === true,
      ask: r.unresolved === 'ask',
    },
  };
}

/* ------------------------------- target checks ------------------------------- */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostInScope(host, scope) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  const ip = ipv4Of(h);
  if (ip !== null) {
    if (scope.cidrs.some((c) => ip >= c.start && ip <= c.end)) return true;
    return scope.hosts.includes(h);
  }
  for (const p of scope.hosts) {
    if (p === h) return true;
    if (p.startsWith('*.') && h.endsWith(p.slice(1)) && h.length > p.length - 1) return true;
  }
  return false;
}

/** Parses a URL or a "host/path" or "host:port"; returns a URL object, or null. URL() also normalises 0xC0000201 and 3221225985 to dotted form. */
function parseTarget(raw) {
  let s = String(raw).trim().replace(/^[<([{'"]+|[>)\]}'",;.]+$/g, '');
  if (!s) return null;
  if (s.startsWith('//')) s = 'http:' + s;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try { return new URL(s); } catch (_) { return null; }
}

function urlInScope(u, scope) {
  if (hostInScope(u.hostname, scope)) return true;
  return scope.prefixes.some((p) => p.origin === u.origin && (u.pathname === p.pathname.replace(/\/$/, '') || u.pathname.startsWith(p.pathname.endsWith('/') ? p.pathname : p.pathname + '/')));
}

const URL_IN_TEXT_RE = /[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"<>`\\]+/gi;
const NESTED_URL_RE = /(?<![a-z0-9+.-])(?=([a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"<>`\\]+))/gi;
const PROTO_REL_RE = /(?:^|[\s=&?'"(,])(\/\/[a-z0-9.[\]:@-]{2,253}[^\s'"<>`]*)/gi;
const BARE_IPV4_RE = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?![\w.])/g;

/** Every URL, protocol-relative target and IPv4 literal in a text, also after percent-decoding, as URL objects or {cidr}. */
function targetsInText(text, withBareIp) {
  const out = [];
  for (const copy of [text, ...policy.egressDecodedCopies(text)]) {
    for (const m of copy.matchAll(URL_IN_TEXT_RE)) {
      const u = parseTarget(m[0]);
      if (u) out.push(u);
      // A URL inside a URL (a redirect or a "next" parameter) is a target of its own.
      if (m[0].length > 4096) out.push({ cidr: 'oversized-url' });
      else for (const n of m[0].matchAll(NESTED_URL_RE)) { if (n.index === 0) continue; const v = parseTarget(n[1]); if (v) out.push(v); }
    }
    for (const m of copy.matchAll(PROTO_REL_RE)) { const u = parseTarget(m[1]); if (u) out.push(u); }
    if (withBareIp) {
      for (const m of copy.matchAll(BARE_IPV4_RE)) {
        if (m[0].includes('/')) out.push({ cidr: m[0] });
        else { const u = parseTarget(m[0]); if (u) out.push(u); }
      }
    }
  }
  return out;
}

/** Collects problems for a list of targets: {out: [host], dynamic: [text]}. */
function judgeTargets(list, scope, res) {
  for (const t of list) {
    if (t.cidr) {
      const c = cidrOf(t.cidr);
      if (!c || !scope.cidrs.some((a) => c.start >= a.start && c.end <= a.end)) res.out.add(t.cidr);
      continue;
    }
    const raw = t.hostname || '';
    if (/[${}`%]/.test(raw)) { res.dynamic.add('a host that is built at run time'); continue; }
    if (LOCAL_HOSTS.has(t.hostname)) continue;
    if (!urlInScope(t, scope)) res.out.add(t.hostname || '(empty host)');
  }
}

/* ------------------------------- shell commands ------------------------------- */

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'timeout', 'nice', 'command', 'exec', 'stdbuf', 'xargs', 'doas']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const INTERPRETERS = /^(?:python[0-9.]*|py|node|nodejs|deno|bun|ruby|perl|php|pwsh|powershell)$/;
const NETPROGS = new Set(['nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'ping', 'nmap', 'dig', 'nslookup', 'host', 'socat', 'traceroute', 'mtr']);
const GIT_NET = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'remote', 'submodule']);
const NET_API_RE = /\b(?:requests|urllib|http\.client|httpx|aiohttp|socket|urlopen|axios|XMLHttpRequest|WebSocket|net\.connect|net\.Socket|https?\.(?:request|get)|dns\.resolve|subprocess|os\.system|child_process|spawn|curl|wget|ncat?|ssh|scp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b|\bfetch\s*\(|\bexec\s*\(/;
const GLOBAL_DYNAMIC_RE = /\b(?:sys\.argv|os\.environ|getenv|process\.env|process\.argv|input\s*\(|readline|b64decode|base64|atob\s*\(|fromCharCode|chr\s*\(|eval\s*\(|compile\s*\(|__import__|importlib)|\$\{?(?:[0-9@*#])/;
const LINE_DYNAMIC_RE = /\$\{?\w|`|\bf["'][^"']*\{|\.format\s*\(|%[sd(]|\+/;

function progOf(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const name = path.basename(w.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
    if (/^[A-Za-z_]\w*=/.test(w) || WRAPPERS.has(name) || w.startsWith('-') || /^\d+[smhd]?$/.test(w)) continue;
    return { name, index: i, word: w };
  }
  return null;
}

function simpleCommands(cmd, depth, out) {
  let rest = String(cmd);
  for (let guard = 0; rest.length && guard < COMMANDS_MAX; guard++) {
    const scan = policy.scanFirstCommand(rest, false);
    const words = scan.words.map((w) => w.text);
    if (words.length) {
      out.push({ words, text: rest.slice(0, Math.max(scan.end, 1)) });
      const p = progOf(words);
      if (p && SHELLS.has(p.name) && depth < SHELL_CODE_DEPTH) {
        const c = words.findIndex((w, i) => i > p.index && /^-[A-Za-z]*c$/.test(w));
        if (c >= 0 && words[c + 1] !== undefined) simpleCommands(words[c + 1], depth + 1, out);
      }
    }
    if (scan.end < 0 || scan.end >= rest.length) break;
    rest = rest.slice(scan.end + 1);
  }
  return out;
}

function scriptVerdict(text, scope, res, label) {
  if (!NET_API_RE.test(text)) return;
  // A line that builds text (a format string, a concatenation) is unresolved as a whole; the other lines are judged by
  // the targets they name, so a literal that is only a fragment is not taken for a host.
  let named = 0;
  let dynamic = GLOBAL_DYNAMIC_RE.test(text);
  for (const line of text.split(/\r?\n/)) {
    const lits = targetsInText(line, true);
    named += lits.length;
    if ((NET_API_RE.test(line) || /[a-z]+:\/\//i.test(line)) && LINE_DYNAMIC_RE.test(line)) dynamic = true;
    else judgeTargets(lits, scope, res);
  }
  if (dynamic) res.dynamic.add(label + ' may build its target at run time');
  else if (!named) res.dynamic.add(label + ' uses the network but names no target');
}

function readScript(file, cwd) {
  const abs = path.resolve(cwd || process.cwd(), file);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > SCRIPT_MAX_BYTES) return { error: 'is not a plain file under ' + SCRIPT_MAX_BYTES + ' bytes' };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return { error: 'is a binary file' };
    return { text: buf.toString('utf8'), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch (_) {
    return { error: 'cannot be read' };
  }
}

function judgeCommand(command, cwd, scope) {
  const res = { out: new Set(), dynamic: new Set(), redirect: false, requests: 0, scripts: [] };
  const raw = String(command || '');
  if (raw.length > policy.SHELL_SCAN_CAP) { res.dynamic.add('the command is too long to read'); return res; }
  const hostVar = /:\/\/[^\s'"/]*[$`]/.test(raw);
  if (hostVar) res.dynamic.add('a host that is built at run time');
  // Hosts the engine's own request parser finds (curl, wget, inline code, PowerShell cmdlets).
  const found = policy.egressParts(raw, { allow: [] });
  for (const r of found) {
    res.requests++;
    if (!r.hosts.length) res.dynamic.add('a request whose target cannot be read');
    if (r.hosts.some((h) => /[${}`%]/.test(h))) res.dynamic.add('a host that is built at run time');
    // The parts have their variable references removed, so a host written as a variable would read as another host.
    // An address in a header or a body counts as a target too: a request can carry the place it should reach.
    for (const p of hostVar ? [] : r.parts) {
      if (p.where === 'url') { const u = parseTarget(p.text); if (u) judgeTargets([u], scope, res); }
      judgeTargets(targetsInText(p.text, true), scope, res);
    }
  }
  judgeTargets(targetsInText(raw, false), scope, res);
  for (const c of simpleCommands(raw, 0, [])) {
    const p = progOf(c.words);
    if (!p) continue;
    const args = c.words.slice(p.index + 1).filter((a) => a !== '-' && !/^\d*[<>]/.test(a)); // "-" and redirections or here-document markers
    if (p.name === 'curl' || p.name === 'wget') {
      const local = targetsInText(c.text, false).some((u) => u.hostname && LOCAL_HOSTS.has(u.hostname));
      if (!policy.egressParts(c.text, { allow: [] }).length && !local) res.dynamic.add(p.name + ' with no target that can be read');
      if (p.name === 'curl' ? args.some((a) => /^-[A-Za-z]*L[A-Za-z]*$/.test(a) || /^--location(?:-trusted)?$/.test(a))
        : !args.some((a, i) => /^--max-redirect=0$/.test(a) || (a === '--max-redirect' && args[i + 1] === '0'))) res.redirect = true;
    } else if (NETPROGS.has(p.name)) {
      res.requests++;
      const cands = [];
      for (const a of args) {
        if (a.startsWith('-') || /^[\d,-]+$/.test(a)) continue;
        if (/[$`]/.test(a)) { res.dynamic.add(p.name + ' with a target that is built at run time'); continue; }
        let h = a.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '');
        if (/\/\d{1,2}$/.test(h) && ipv4Of(h.split('/')[0]) !== null) { cands.push({ cidr: h }); continue; }
        h = h.split(/[/:]/, 1)[0];
        const u = parseTarget(h);
        if (u && h) cands.push(u);
      }
      if (!cands.length) res.dynamic.add(p.name + ' with no target that can be read');
      judgeTargets(cands, scope, res);
    } else if (p.name === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub && GIT_NET.has(sub)) {
        res.requests++;
        const urls = args.filter((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^[\w.-]+@[\w.-]+:/.test(a)).map((a) => parseTarget(a.replace(/^[\w.-]+@([\w.-]+):.*$/, '$1')));
        if (!urls.length) res.dynamic.add('git ' + sub + ' to a remote taken from the repository settings');
        judgeTargets(urls.filter(Boolean), scope, res);
      }
    } else if (INTERPRETERS.test(p.name) || SHELLS.has(p.name) || /^(?:\.{1,2}\/|\/)/.test(p.word) || /\.(?:sh|py|js|mjs|cjs|ps1|rb|pl)$/i.test(p.word)) {
      const isInterp = INTERPRETERS.test(p.name) || SHELLS.has(p.name);
      const inline = args.findIndex((a) => /^-[A-Za-z]*[ce]$/.test(a) || a === '--eval' || a === '--command' || a === '-Command');
      if (isInterp && inline >= 0) continue; // the inline code is read by the request parser above and, for sh -c, as a command of its own
      let file = isInterp ? args.find((a) => !a.startsWith('-')) : p.word;
      if (isInterp && !file) {
        // Code on standard input: a here-document is in the command text, a pipe is not.
        if (/<<-?\s*['"]?\w/.test(raw)) scriptVerdict(raw, scope, res, 'the here-document');
        else if (SHELLS.has(p.name) || INTERPRETERS.test(p.name)) res.dynamic.add('code that arrives on standard input');
        continue;
      }
      if (isInterp && args.includes('-m')) { res.dynamic.add(p.name + ' -m runs a module that is not read'); continue; }
      const s = readScript(file, cwd);
      if (s.error) { res.dynamic.add('the script ' + JSON.stringify(String(file).slice(0, 60)) + ' ' + s.error); continue; }
      res.scripts.push({ file: String(file).slice(0, 120), sha256: s.sha256 });
      scriptVerdict(s.text, scope, res, 'the script ' + JSON.stringify(String(file).slice(0, 60)));
    }
  }
  return res;
}

/* ------------------------------- decisions ------------------------------- */

function mcpTargets(args) {
  let text = '';
  try { text = JSON.stringify(args === undefined ? '' : args).slice(0, 1024 * 1024); } catch (_) { return null; }
  return text;
}

function statePathOf(opts) {
  return opts.scopeState || path.join(opts.home || os.homedir(), '.zn', 'scope-state.json');
}

function countRequests(opts, sha, add, max) {
  const file = statePathOf(opts);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { state = {}; }
  const used = state.sha256 === sha && Number.isInteger(state.requests) ? state.requests : 0;
  if (used + add > max) return { ok: false, used };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ sha256: sha, requests: used + add }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (_) {
    return { ok: false, used, unwritable: true }; // a counter that cannot be kept cannot enforce the limit: fail closed
  }
  return { ok: true, used: used + add };
}

function refuse(ev, opts, sha, code, detail, hosts, extra) {
  const short = sha ? sha.slice(0, 12) : 'none';
  const message = 'zn: out of scope (' + code + '): ' + detail + '. Scope file ' + short + '. Next step: tell the user; do not retry with another spelling of the target or through a script.';
  try {
    const file = opts.home ? path.join(opts.home, '.zn', 'evidence.jsonl') : undefined;
    require('../evidence').logEvidence({
      agent: opts.agentId || 'unknown',
      phase: 'scope-guard',
      tool_name: ev.tool || ev.event || 'unknown',
      payload: JSON.stringify({ scope_sha256: sha || null, tool: ev.tool || null, code, hosts: [...hosts].slice(0, 8).map((h) => String(h).replace(/[^A-Za-z0-9.:/_-]/g, '').slice(0, 60)), ...extra }),
      verdict: 'block',
      rule: 'scope-' + code,
      reason: 'scope_sha256=' + (sha || 'none') + ' ' + detail.slice(0, 200),
      engine: 'zn-scope-guard',
    }, file, { lockWaitMs: 500, noStats: true, _plainPreview: true });
  } catch (_) { /* the refusal stands even if the log cannot be written */ }
  return { decision: 'deny', message, scopeRefusal: code };
}

function unresolved(ev, opts, sha, scope, detail, hosts) {
  const r = refuse(ev, opts, sha, 'unresolved', detail, hosts || []);
  return scope.ask ? { ...r, decision: 'ask', message: r.message.replace('Next step: tell the user;', 'Approve it only if the target is in scope. Next step:') } : r;
}

/**
 * The scope decision for one pre-tool event, or null when it is in scope (the other checks then run) or no scope file
 * is configured. opts: scopeFile, scopeSha256 (pin), home, now, scopeState, agentId.
 */
function decide(ev, opts = {}) {
  if (!opts.scopeFile) return null;
  const loaded = loadScope(opts.scopeFile);
  if (!loaded.ok) return refuse(ev, opts, loaded.sha256, 'scope-file', loaded.error, []);
  const { scope, sha256 } = loaded;
  if (opts.scopeSha256 && String(opts.scopeSha256).toLowerCase() !== sha256) return refuse(ev, opts, sha256, 'scope-file', 'the scope file is not the one that was approved (its hash changed)', []);
  const now = opts.now !== undefined ? opts.now : Date.now();
  if (scope.window && (now < scope.window.notBefore || now > scope.window.notAfter)) return refuse(ev, opts, sha256, 'time-window', 'the time window of the scope is not open', []);

  const tool = String(ev.tool || '').toLowerCase();
  const input = ev.input || {};
  let requests = 0;
  const res = { out: new Set(), dynamic: new Set() };

  if (tool === 'mcp') {
    const server = ev.mcp && ev.mcp.server ? String(ev.mcp.server) : '';
    const name = ev.mcp && ev.mcp.tool ? String(ev.mcp.tool) : '';
    if (!server || !scope.mcpServers.includes(server)) return refuse(ev, opts, sha256, 'mcp-server', 'the MCP server ' + JSON.stringify(server.slice(0, 40) || '(unknown)') + ' is not in scope', []);
    if (scope.mcpTools && !(scope.mcpTools.includes(server + '/*') || (name && scope.mcpTools.includes(server + '/' + name)))) return refuse(ev, opts, sha256, 'mcp-tool', 'the MCP tool ' + JSON.stringify(server + '/' + name.slice(0, 40)) + ' is not in scope', []);
    const text = mcpTargets(input.args);
    if (text === null) return unresolved(ev, opts, sha256, scope, 'the arguments of the MCP call cannot be read');
    const list = targetsInText(text, true);
    judgeTargets(list, scope, res);
    requests = list.length;
  } else {
    if (!scope.tools.has(tool)) return refuse(ev, opts, sha256, 'tool', 'the tool ' + JSON.stringify(tool.slice(0, 40) || '(unknown)') + ' is not in scope', []);
    if (tool === 'webfetch') {
      const u = parseTarget(input.url);
      if (!u) return unresolved(ev, opts, sha256, scope, 'the URL of the call cannot be read');
      judgeTargets([u, ...targetsInText(String(input.url), false)], scope, res);
      requests = 1;
    } else if (tool === 'bash' || tool === 'powershell') {
      const j = judgeCommand(input.command, ev.cwd, scope);
      j.out.forEach((h) => res.out.add(h));
      j.dynamic.forEach((d) => res.dynamic.add(d));
      requests = j.requests;
      if (j.redirect && !scope.followRedirects && res.out.size === 0) res.dynamic.add('a redirect that the program would follow to a target that is not checked');
    }
  }

  if (res.out.size) return refuse(ev, opts, sha256, 'target', 'target not in scope: ' + [...res.out].slice(0, 3).join(', '), res.out);
  if (res.dynamic.size) return unresolved(ev, opts, sha256, scope, 'cannot tell where this goes (' + [...res.dynamic].slice(0, 2).join('; ') + ')');
  if (scope.maxRequests !== null && requests > 0) {
    const c = countRequests(opts, sha256, requests, scope.maxRequests);
    if (!c.ok) return refuse(ev, opts, sha256, 'max-requests', c.unwritable ? 'the request counter cannot be kept' : 'the limit of ' + scope.maxRequests + ' requests is used up', []);
  }
  return null;
}

/**
 * Checks that the scope file in force is the one the events were recorded under. Reads the evidence log and returns
 * {scopeSha256, events, matching, others: [sha256]}: every scope-guard event names the hash of the file it used.
 */
function verify(scopeFile, evidenceFile) {
  const loaded = loadScope(scopeFile);
  const out = { scopeSha256: loaded.sha256 || null, valid: loaded.ok, events: 0, matching: 0, others: [] };
  let text = '';
  try { text = fs.readFileSync(evidenceFile, 'utf8'); } catch (_) { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('"scope-guard"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (rec.phase !== 'scope-guard') continue;
    out.events++;
    const m = /scope_sha256=([0-9a-f]{64}|none)/.exec(rec.reason || '');
    if (m && m[1] === out.scopeSha256) out.matching++;
    else if (!out.others.includes(m ? m[1] : 'missing')) out.others.push(m ? m[1] : 'missing');
  }
  return out;
}

module.exports = { loadScope, decide, verify, hostInScope, _judgeCommand: judgeCommand };
