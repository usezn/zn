'use strict';

/**
 * Single entry point for agent hooks:  zn hook <agent-id>  (event JSON on stdin)
 *
 *   raw agent event -> adapter.normalize() -> decide() -> adapter.respond() -> stdout
 *
 * The runner keeps no state of its own: token mappings and secrets live in
 * the vault daemon, reached through lib/vault/client.js. Decisions:
 *
 *   pre_tool    deny reads of credential files and ~/.zn, deny secret
 *               management commands, wrap Bash commands that carry
 *               __ZN_<NAME>__ markers in `zn run --` (ask), restore detected
 *               tokens per the restore policy (ask), refuse markers in
 *               WebFetch URLs (use secrets_http_request instead).
 *   post_tool   replace secrets in the tool output with tokens (Read, Bash,
 *               Grep, WebFetch and MCP tools), keeping the output's shape.
 *   user_prompt block prompts that contain a secret and suggest
 *               `zn secret set`.
 *
 * Failure handling: fail-open by default (the event passes untouched and a
 * warning goes to stderr). Set ZN_HOOK_FAIL_MODE=closed, or
 * {"hooks": {"failMode": "closed"}} in ~/.zn/config.json, to deny the tool
 * call / withhold the output / block the prompt instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./policy');
const markers = require('../broker/markers');
const { gitStatusOf } = require('../broker/files');
const deps = require('../deps');

const SECRET_SOURCES = new Set(['exact', 'pattern']);
const POST_TOOLS = new Set(['read', 'bash', 'grep', 'webfetch', 'mcp']);

function readConfig(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home || os.homedir(), '.zn', 'config.json'), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function failModeOf(opts) {
  const v = opts.failMode || process.env.ZN_HOOK_FAIL_MODE || ((readConfig(opts.home).hooks || {}).failMode);
  return String(v || 'open').toLowerCase() === 'closed' ? 'closed' : 'open';
}

/** Map every string leaf of a JSON value through an async function, keeping the shape. */
async function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await mapStrings(v, fn));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await mapStrings(v, fn);
    return out;
  }
  return value;
}

function lazyDeps(opts) {
  let engine = opts.engine;
  let vault = opts.vault;
  return {
    engine() {
      if (!engine) engine = deps.loadEngine();
      return engine;
    },
    async vault() {
      if (!vault) vault = await deps.loadVault();
      return vault;
    },
  };
}

function znRunPrefix(opts, agentId) {
  if (opts.znRunPrefix) return opts.znRunPrefix;
  const q = (s) => '"' + String(s).replace(/\\/g, '/').replace(/"/g, '\\"') + '"';
  const runJs = path.resolve(__dirname, '..', 'broker', 'run.js');
  return 'ZN_AGENT=' + agentId + ' ' + q(process.execPath) + ' ' + q(runJs) + ' --';
}

async function ctxFor(ev, d, agentId, destination, needVault = true) {
  return {
    project: deps.findProjectRoot(ev.cwd || process.cwd()),
    agent: agentId,
    tool: ev.toolName || ev.tool,
    destination,
    vault: needVault ? await d.vault() : undefined,
  };
}

/* ---------------------------- pre_tool ---------------------------- */

async function decidePre(ev, d, agentId, opts) {
  const pathOpts = { cwd: ev.cwd, home: opts.home };
  const input = ev.input || {};
  const tool = ev.tool;

  if (tool === 'read' || (tool === 'grep' && input.path)) {
    const deny = policy.readDenial(input.path, pathOpts);
    if (deny) return { decision: 'deny', message: deny };
  }
  if (tool === 'write' || tool === 'edit' || tool === 'multiedit' || tool === 'notebookedit') {
    const deny = policy.writeDenial(input.path, pathOpts);
    if (deny) return { decision: 'deny', message: deny };
  }

  if (tool === 'webfetch') {
    if (markers.findMarkers(input.url || '').length) {
      return {
        decision: 'deny',
        message: 'zn: WebFetch never receives secret values. For an authenticated HTTP call use the secrets_http_request tool ' +
          'of the zn "secrets" MCP server: zn sends the request with the real value, only to the hosts allowed for that secret.',
      };
    }
    return { decision: 'allow' };
  }

  if (tool === 'bash') {
    const original = String(input.command || '');
    const deny = policy.bashDenial(original, pathOpts);
    if (deny) return { decision: 'deny', message: deny };

    let command = original;
    const notes = [];
    const wrap = policy.wrapWithZnRun(command, znRunPrefix(opts, agentId));
    if (!wrap.ok) return { decision: 'deny', message: wrap.reason };
    if (wrap.wrapped) {
      command = wrap.command;
      notes.push('runs through `zn run` for ' + markers.findNamedMarkers(original).map((m) => m.name).join(', ') +
        ' (allowCommands, first-use approval and output masking apply)');
    }

    const detected = markers.findMarkers(command).filter((m) => m.detected);
    if (detected.length) {
      const network = policy.hasNetworkSignals(command);
      const ctx = await ctxFor(ev, d, agentId, network ? 'bash_network' : 'bash_local');
      const res = await d.engine().detokenize(command, ctx);
      if (res && typeof res.text === 'string' && res.restored && res.restored.length) {
        command = res.text;
        notes.push('restores ' + res.restored.length + ' scrubbed value(s) for a local command');
      }
      if (res && res.withheld && res.withheld.length) {
        notes.push('kept ' + res.withheld.length + ' token(s) unresolved: ' +
          res.withheld.map((w) => w.token + ' (' + w.reason + ')').join(', '));
      }
    }

    if (command === original) {
      if (markers.findMarkers(original).length) {
        // A command that carries markers always asks, even when nothing was rewritten
        // (already wrapped in `zn run` by the agent, or tokens kept unresolved).
        // Never let it run on the user's allow rules alone.
        return { decision: 'ask', message: 'zn: this command carries secret markers' + (notes.length ? '; ' + notes.join('; ') : '') + '.' };
      }
      return notes.length ? { decision: 'allow', message: 'zn: ' + notes.join('; ') } : { decision: 'allow' };
    }
    return { decision: 'ask', updatedInput: { command }, message: 'zn: this command ' + notes.join('; ') + '.' };
  }

  if ((tool === 'write' || tool === 'edit' || tool === 'multiedit' || tool === 'notebookedit') && Array.isArray(input.texts)) {
    const withMarkers = input.texts.filter((t) => markers.findMarkers(t.value).length);
    if (withMarkers.length === 0) return { decision: 'allow' };
    const status = input.path ? gitStatusOf(path.resolve(ev.cwd || process.cwd(), input.path)) : 'unknown';
    const destination = status === 'ignored' || status === 'outside' ? 'write_ignored' : 'write_tracked';
    const ctx = await ctxFor(ev, d, agentId, destination);
    const updates = [];
    let restored = 0;
    const withheld = [];
    for (const t of withMarkers) {
      const res = await d.engine().detokenize(t.value, ctx);
      if (res && res.restored && res.restored.length && res.text !== t.value) {
        updates.push({ key: t.key, value: res.text });
        restored += res.restored.length;
      }
      if (res && res.withheld) withheld.push(...res.withheld);
    }
    const why = withheld.length
      ? ' Kept as tokens: ' + withheld.map((w) => w.token).join(', ') + (destination === 'write_tracked'
        ? ' (this file can be committed, so secrets stay as markers; put real values in a git-ignored file such as .env.local).'
        : '.')
      : '';
    if (updates.length === 0) return { decision: 'allow', message: why ? 'zn:' + why : undefined };
    return {
      decision: 'ask',
      updatedInput: { texts: updates },
      message: 'zn: restores ' + restored + ' secret value(s) in a git-ignored file.' + why,
    };
  }

  return { decision: 'allow' };
}

/* ---------------------------- post_tool --------------------------- */

async function decidePost(ev, d, agentId) {
  if (!POST_TOOLS.has(ev.tool)) return { decision: 'allow' };
  if (ev.output === undefined || ev.output === null) return { decision: 'allow' };
  const ctx = await ctxFor(ev, d, agentId, 'assistant');
  const engine = d.engine();
  const types = new Map();
  const updated = await mapStrings(ev.output, async (s) => {
    if (s.length < 8) return s;
    const res = await engine.tokenize(s, ctx);
    if (!res || typeof res.text !== 'string') throw deps.znError('ZN_ENGINE', 'tokenize returned an unexpected shape');
    for (const r of res.replaced || []) types.set(r.type, (types.get(r.type) || 0) + 1);
    return res.text;
  });
  if (types.size === 0) return { decision: 'allow' };
  const total = [...types.values()].reduce((a, b) => a + b, 0);
  const summary = [...types.entries()].map(([t, n]) => t + (n > 1 ? ' x' + n : '')).join(', ');
  return {
    decision: 'allow',
    updatedOutput: updated,
    message: 'zn: ' + total + ' secret value(s) in this output were replaced with __ZN_ tokens (' + summary + '). ' +
      'Real values stay on this machine; use the tokens as they are.',
  };
}

/* --------------------------- user_prompt -------------------------- */

async function decidePrompt(ev, d, agentId) {
  const prompt = String((ev.input && ev.input.prompt) || '');
  if (prompt.length < 8) return { decision: 'allow' };
  const ctx = await ctxFor(ev, d, agentId, 'assistant');
  const spans = d.engine().scan(prompt, ctx) || [];
  const secrets = spans.filter((s) => SECRET_SOURCES.has(s.source));
  if (secrets.length === 0) return { decision: 'allow' };
  const kinds = [...new Set(secrets.map((s) => s.name || s.type))];
  const suggestion = kinds.length === 1 && /^[A-Z][A-Z0-9_]*$/.test(String(secrets[0].name || ''))
    ? secrets[0].name
    : String(secrets[0].type || 'MY_SECRET').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_\d+$/, '') || 'MY_SECRET';
  return {
    decision: 'deny',
    message: 'zn: this prompt was not sent because it contains a secret (' + kinds.join(', ') + '). ' +
      'Store it locally instead: run `zn secret set ' + suggestion + '` in your terminal, then refer to it as __ZN_' +
      suggestion + '__ in your prompt.',
  };
}

/* ------------------------------ entry ----------------------------- */

function failDecision(ev, err, mode) {
  const msg = 'zn: hook error (' + (err.code || 'error') + '): ' + err.message;
  if (mode !== 'closed') return { decision: 'allow', failOpen: true, warning: msg };
  if (ev && ev.event === 'post_tool' && ev.output !== undefined) {
    const withheld = '[zn: output withheld because the secret scrubber is unavailable: ' + (err.code || 'error') + ']';
    const shape = (v) => (typeof v === 'string' ? withheld
      : Array.isArray(v) ? v.map(shape)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v);
    return { decision: 'allow', updatedOutput: shape(ev.output), message: msg };
  }
  return { decision: 'deny', message: msg + ' (fail-closed)' };
}

/**
 * Handle one raw event. Returns {output, stderr} where output is the JSON
 * value to print (or null for "no opinion").
 * opts: {engine, vault, failMode, home, znRunPrefix}
 */
async function handle(adapter, rawEvent, opts = {}) {
  const mode = failModeOf(opts);
  let ev = null;
  let decision;
  try {
    ev = adapter.normalize(rawEvent);
    const d = lazyDeps(opts);
    if (!ev || !ev.event) decision = { decision: 'allow' };
    else if (ev.event === 'pre_tool') decision = await decidePre(ev, d, adapter.id, opts);
    else if (ev.event === 'post_tool') decision = await decidePost(ev, d, adapter.id);
    else if (ev.event === 'user_prompt') decision = await decidePrompt(ev, d, adapter.id);
    else decision = { decision: 'allow' };
  } catch (err) {
    decision = failDecision(ev, err, mode);
  }
  const output = adapter.respond({ ...decision, event: ev });
  return { output, stderr: decision.warning || null, decision };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

async function main(args) {
  const agentId = args[0];
  let adapter;
  try {
    adapter = require('../agents').getAdapter(agentId);
  } catch (err) {
    process.stderr.write('zn hook: ' + err.message + '\n');
    process.exitCode = 1;
    return;
  }
  let raw;
  try {
    raw = JSON.parse(await readStdin());
  } catch (err) {
    process.stderr.write('zn hook: invalid event JSON on stdin (' + err.message + '); passing through\n');
    return;
  }
  const res = await handle(adapter, raw);
  if (res.stderr) process.stderr.write(res.stderr + ' (fail-open: event passed through)\n');
  if (res.output !== null && res.output !== undefined) process.stdout.write(JSON.stringify(res.output));
}

module.exports = { handle, main, mapStrings, decidePre, decidePost, decidePrompt };

// Direct entry (`node lib/hooks/runner.js <agent>`): what installed hooks call,
// so a hook does not pay for loading the rest of the CLI.
if (require.main === module) main(process.argv.slice(2));
