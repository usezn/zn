'use strict';

/**
 * MCP server "secrets" (stdio, JSON-RPC 2.0, same protocol handling as
 * lib/mcp.js, no dependencies):  zn secrets-mcp
 *
 * Tools:
 *   secrets_list           names and policy of the stored secrets, never values
 *   secrets_http_request   zn makes the HTTP request with __ZN_<NAME>__ markers
 *                          replaced, only if the host is in each secret's
 *                          allowHosts; the response is scrubbed before it returns
 *   secrets_render_file    render a template with markers into a git-ignored
 *                          file (or one outside any repository); secrets in
 *                          mode "file" only
 *   secrets_request        ask the user to add a secret; never takes a value
 *
 * There is deliberately no tool that returns a secret value.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const markers = require('./markers');
const { createMasker } = require('./mask');
const { gitStatusOf, writeFileAtomic } = require('./files');
const policy = require('../hooks/policy');
const deps = require('../deps');

const SERVER_NAME = 'zn-secrets';
let SERVER_VERSION = '0.0.0';
try { SERVER_VERSION = require('../../package.json').version; } catch (_) { /* keep default */ }
const PROTOCOL_VERSION = '2024-11-05';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const FORBIDDEN_HEADERS = /^(host|proxy-.*|connection|content-length|transfer-encoding|upgrade|te|trailer|keep-alive)$/i;

const NO_GET = 'There is no tool that returns a secret value, by design: use the __ZN_<NAME>__ marker and zn fills it in where it is allowed.';

const TOOLS = [
  {
    name: 'secrets_list',
    description: 'List the secrets stored in the local zn vault: name, marker, mode, allowed hosts and allowed commands. Never returns values. ' + NO_GET,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'secrets_http_request',
    description: 'Make an HTTP request that needs a secret. Write the secret as its marker (for example "Authorization": "Bearer __ZN_GITHUB_TOKEN__") in the url, headers or body; zn sends the request with the real value, only if the host is in that secret\'s allowHosts, and returns the response with any secret replaced by markers. Use this instead of curl or WebFetch for authenticated APIs. ' + NO_GET,
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method, e.g. GET, POST, PATCH, DELETE.' },
        url: { type: 'string', description: 'Absolute https:// URL (http:// only for localhost).' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers; values may contain __ZN_<NAME>__ markers.' },
        body: { type: 'string', description: 'Request body as text (JSON must be serialized); may contain markers.' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'secrets_render_file',
    description: 'Render a template file that contains __ZN_<NAME>__ markers into an output file with the real values, for tools that need a config file (e.g. ~/.npmrc). Only for secrets in "file" mode, and the output must be git-ignored or outside any git repository. Returns only the output path, never the content. ' + NO_GET,
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Path of the template file (with markers).' },
        out: { type: 'string', description: 'Path of the file to write (git-ignored or outside the repository).' },
      },
      required: ['template', 'out'],
    },
  },
  {
    name: 'secrets_request',
    description: 'Ask the user to add a secret you need (for example GITHUB_TOKEN). The user adds the value in their own terminal; you never receive it. Do not pass a value: if you already have it, it is exposed and the user should rotate it. ' + NO_GET,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Secret name: upper case, digits and underscores, e.g. STRIPE_API_KEY.' },
        reason: { type: 'string', description: 'Why it is needed (shown to the user).' },
      },
      required: ['name', 'reason'],
    },
  },
];

function textResult(obj, isError = false) {
  return { isError, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function denied(message) {
  return textResult({ error: 'ZN_POLICY_DENIED', message }, true);
}

/**
 * Build a server bound to its dependencies.
 * opts: {vault, engine, fetch, cwd, home, agent, notify}
 */
function createSecretsServer(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const home = opts.home || os.homedir();
  const project = deps.findProjectRoot(cwd);
  const agent = opts.agent || process.env.ZN_AGENT || 'mcp';
  const doFetch = opts.fetch || globalThis.fetch;
  let vault = opts.vault;
  let engine = opts.engine;
  const getVault = async () => (vault = vault || await deps.loadVault());
  const getEngine = () => (engine = engine || deps.loadEngine());
  const notify = opts.notify || ((line) => process.stderr.write(line + '\n'));

  async function audit(ev) {
    try { await (await getVault()).audit({ agent, ...ev }); } catch (_) { /* never let audit change a decision */ }
  }

  async function metaMap() {
    const list = await (await getVault()).listSecrets();
    return new Map((list || []).map((s) => [s.name, s]));
  }

  async function scrub(text, masker) {
    const masked = masker.maskText(text);
    const res = await getEngine().tokenize(masked, { project, agent, tool: 'mcp:secrets_http_request', destination: 'assistant', vault: await getVault() });
    return res && typeof res.text === 'string' ? res.text : masked;
  }

  async function list() {
    const meta = await metaMap();
    return textResult({
      secrets: [...meta.values()].map((s) => ({
        name: s.name,
        marker: markers.markerFor(s.name),
        mode: s.mode || 'proxy',
        allowHosts: s.allowHosts || [],
        allowCommands: s.allowCommands || [],
        lastUsed: s.lastUsed || null,
      })),
      note: NO_GET,
    });
  }

  async function httpRequest(args) {
    const method = String(args.method || 'GET').toUpperCase();
    if (!/^[A-Z]{3,10}$/.test(method)) return denied('invalid HTTP method');
    let url;
    try { url = new URL(String(args.url || '')); } catch (_) { return denied('url must be an absolute URL'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && markers.isLoopbackHost(url.hostname))) {
      return denied('only https:// URLs are allowed (http:// only for localhost)');
    }
    if (url.username || url.password) return denied('put credentials in headers, not in the URL userinfo');
    const host = url.hostname.toLowerCase();
    const headers = {};
    for (const [k, v] of Object.entries(args.headers && typeof args.headers === 'object' ? args.headers : {})) {
      if (FORBIDDEN_HEADERS.test(k)) return denied('header ' + k + ' cannot be set');
      headers[k] = String(v);
    }
    const body = args.body === undefined || args.body === null ? undefined : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body));

    const carriers = [String(args.url), ...Object.keys(headers), ...Object.values(headers), body || ''];
    const found = new Map();
    for (const c of carriers) for (const m of markers.findMarkers(c)) found.set(m.name, m);
    const detected = [...found.values()].filter((m) => m.detected);
    if (detected.length) {
      return denied(detected.map((m) => m.marker).join(', ') + ' is a value the scrubber found in a file, not a stored secret. ' +
        'Ask the user to store it with `zn secret adopt ' + detected[0].name + ' --name <NAME> --host ' + host + '`.');
    }
    const named = [...found.values()];
    const meta = named.length ? await metaMap() : new Map();
    const values = new Map();
    for (const m of named) {
      const s = meta.get(m.name);
      if (!s) {
        await audit({ secret: m.name, mode: null, tool: 'mcp:secrets_http_request', argv0: null, host, decision: 'deny', reason: 'not found' });
        return textResult({ error: 'ZN_NOT_FOUND', message: 'secret ' + m.name + ' is not in the vault; use secrets_request to ask the user for it' }, true);
      }
      if (!markers.hostAllowed(s.allowHosts, host)) {
        await audit({ secret: m.name, mode: s.mode, tool: 'mcp:secrets_http_request', argv0: null, host, decision: 'deny', reason: 'host not in allowHosts' });
        return denied(m.marker + ' may not be sent to ' + host + ' (allowed: ' + ((s.allowHosts || []).join(', ') || 'none') + '). No request was made.');
      }
    }
    getEngine(); // fail before sending if the response cannot be scrubbed
    for (const m of named) {
      const v = await (await getVault()).resolve(project, m.marker);
      if (v == null) return textResult({ error: 'ZN_NOT_FOUND', message: 'secret ' + m.name + ' has no value' }, true);
      values.set(m.name, String(v));
    }
    const masker = createMasker([...values.entries()].map(([name, value]) => ({ name, value })));
    const realHeaders = {};
    for (const [k, v] of Object.entries(headers)) realHeaders[markers.substitute(k, values)] = markers.substitute(v, values);
    const realUrl = markers.substitute(String(args.url), values);
    const realBody = body === undefined ? undefined : markers.substitute(body, values);

    let res;
    try {
      res = await doFetch(realUrl, {
        method,
        headers: realHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : realBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      for (const m of named) await audit({ secret: m.name, mode: meta.get(m.name).mode, tool: 'mcp:secrets_http_request', argv0: null, host, decision: 'allow', reason: 'request failed' });
      return textResult({ error: 'ZN_HTTP_ERROR', message: await scrub(String(err && err.message || err), masker) }, true);
    }
    for (const m of named) await audit({ secret: m.name, mode: meta.get(m.name).mode, tool: 'mcp:secrets_http_request', argv0: null, host, decision: 'allow', reason: method + ' ' + res.status });

    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_RESPONSE_BYTES;
    const text = buf.subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
    const outHeaders = {};
    for (const [k, v] of res.headers.entries()) outHeaders[k] = await scrub(v, masker);
    return textResult({
      status: res.status,
      statusText: res.statusText,
      redirected_to: res.status >= 300 && res.status < 400 ? (outHeaders.location || null) : undefined,
      headers: outHeaders,
      body: await scrub(text, masker),
      truncated,
      note: redirectNote(res.status),
    });
  }

  function redirectNote(status) {
    return status >= 300 && status < 400 ? 'Redirects are not followed automatically; call again with the new URL if it is an allowed host.' : undefined;
  }

  async function renderFile(args) {
    const tpl = path.resolve(cwd, String(args.template || ''));
    const out = path.resolve(cwd, String(args.out || ''));
    if (!args.template || !args.out) return denied('template and out are required');
    const readDeny = policy.readDenial(tpl, { cwd, home });
    if (readDeny) return denied(readDeny);
    if (policy.classifyPath(out, { cwd, home })) {
      const c = policy.classifyPath(out, { cwd, home });
      if (c.kind === 'zn_state') return denied('cannot write into ~/.zn');
    }
    try {
      const st = fs.lstatSync(out);
      if (st.isSymbolicLink() || !st.isFile()) return denied('out exists and is not a regular file');
    } catch (err) {
      if (err.code !== 'ENOENT') return denied('cannot inspect out: ' + err.code);
    }
    const where = gitStatusOf(out);
    if (where !== 'ignored' && where !== 'outside') {
      return denied(out + ' is ' + (where === 'unknown' ? 'in an unknown git state (git not available)' : 'tracked by git (it could be committed)') +
        '. Secret values are only written to git-ignored files or outside the repository.');
    }
    let template;
    try { template = fs.readFileSync(tpl, 'utf8'); } catch (err) { return denied('cannot read template: ' + err.code); }
    const found = markers.findMarkers(template);
    const named = found.filter((m) => !m.detected);
    if (named.length === 0) return denied('the template has no __ZN_<NAME>__ markers');
    const meta = await metaMap();
    const values = new Map();
    for (const m of named) {
      const s = meta.get(m.name);
      if (!s) return textResult({ error: 'ZN_NOT_FOUND', message: 'secret ' + m.name + ' is not in the vault' }, true);
      if (s.mode !== 'file') {
        await audit({ secret: m.name, mode: s.mode, tool: 'mcp:secrets_render_file', argv0: null, host: null, decision: 'deny', reason: 'mode is not file' });
        return denied(m.name + ' is in ' + (s.mode || 'proxy') + ' mode; only "file" mode secrets can be written to disk');
      }
      const v = await (await getVault()).resolve(project, m.marker);
      if (v == null) return textResult({ error: 'ZN_NOT_FOUND', message: 'secret ' + m.name + ' has no value' }, true);
      values.set(m.name, String(v));
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeFileAtomic(out, markers.substitute(template, values), 0o600);
    for (const m of named) await audit({ secret: m.name, mode: 'file', tool: 'mcp:secrets_render_file', argv0: null, host: null, decision: 'allow', reason: 'rendered to a ' + where + ' path' });
    return textResult({
      written: out,
      secrets: named.map((m) => m.name),
      unresolved: found.filter((m) => m.detected).map((m) => m.marker),
      note: 'The file holds real values; reading it back returns markers.',
    });
  }

  async function request(args) {
    if (args.value !== undefined || args.secret !== undefined) {
      return denied('secrets_request never takes a value. If you already have it, it is exposed: tell the user to rotate it and store the new one with zn secret set.');
    }
    const name = String(args.name || '');
    const bad = markers.validateSecretName(name);
    if (bad) return denied('invalid name: ' + bad);
    const reason = String(args.reason || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
    const rec = { ts: new Date().toISOString(), name, reason, agent };
    try {
      const dir = path.join(home, '.zn');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (_) { /* best effort */ }
    await audit({ secret: name, mode: null, tool: 'mcp:secrets_request', argv0: null, host: null, decision: 'ask', reason: reason.slice(0, 120) });
    notify('zn: ' + agent + ' asks for secret ' + name + (reason ? ' (' + reason + ')' : '') + '. Add it with: zn secret set ' + name);
    return textResult({
      requested: name,
      message: 'Asked the user. They add it in their own terminal with `zn secret set ' + name + '` (with --host or --command to allow its use). ' +
        'Tell the user this, then use the marker ' + markers.markerFor(name) + ' once it is stored.',
    });
  }

  async function callTool(name, args) {
    try {
      if (name === 'secrets_list') return await list();
      if (name === 'secrets_http_request') return await httpRequest(args || {});
      if (name === 'secrets_render_file') return await renderFile(args || {});
      if (name === 'secrets_request') return await request(args || {});
      return null;
    } catch (err) {
      const code = err && err.code && String(err.code).startsWith('ZN_') ? err.code : 'ZN_ERROR';
      return textResult({ error: code, message: String(err && err.message || err) }, true);
    }
  }

  /** Returns the JSON-RPC response object, or null for notifications. */
  async function handleMessage(msg) {
    const { id, method, params } = msg || {};
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
      case 'notifications/initialized':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return fail(-32602, 'Invalid params: name is required');
        const result = await callTool(params.name, params.arguments || {});
        if (!result) return fail(-32601, "Tool '" + params.name + "' not found. " + NO_GET);
        return ok(result);
      }
      default:
        return id === undefined ? null : fail(-32601, 'Unsupported method: ' + method);
    }
  }

  return { handleMessage, callTool, TOOLS };
}

function startSecretsMcp(opts = {}) {
  const server = createSecretsServer(opts);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = await server.handleMessage(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

module.exports = { createSecretsServer, startSecretsMcp, TOOLS, SERVER_NAME };
