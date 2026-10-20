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
 *               management commands, deny MCP call arguments that carry
 *               markers or secret values (other servers than zn's own),
 *               wrap shell commands (Bash, PowerShell)
 *               that carry __ZN_<NAME>__ markers in `zn run --` (ask),
 *               restore detected tokens per the restore policy (ask), refuse
 *               markers in WebFetch URLs (use secrets_http_request instead),
 *               and pipe Monitor commands through the streaming scrubber.
 *   post_tool   replace secrets in the tool output with tokens (Read, Bash,
 *               PowerShell, Monitor, Grep, LSP, WebFetch, MCP tools and MCP
 *               resources), keeping the output's shape. Codex, with the opt-in
 *               hooks.replaceToolOutputOnSecret setting, also gets zn's stop
 *               text in place of the result when the output holds a real
 *               secret value (not only a marker).
 *   user_prompt block prompts that contain a secret and suggest
 *               `zn secret set`.
 *   prompt_expansion  (Claude Code) a typed skill or command, expanded: block
 *               the expansion when it would show the model a secret value,
 *               a private key or the lines of a .env file.
 *
 * Vault locked (or its daemon unreachable): the engine still runs without
 * it and replaces values with irreversible __ZN_REDACTED_<TYPE>__ markers;
 * the user is told to run `zn unlock`. Secrets never pass through.
 *
 * Failure handling: every error fails closed: the tool call is denied, the
 * output withheld or the prompt blocked. That includes a missing engine (an
 * agent could rename the file); the user is told how to reinstall, and can
 * choose to let events pass while it is missing with
 * {"hooks": {"whenUnavailable": "allow"}} in ~/.zn/config.json.
 */

// First, so the modules below are compiled through the cache too (a hook is a new process per call).
if (require.main === module) require('../compile-cache').enable();

const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./policy');
const markers = require('../broker/markers');
const { gitStatusOf } = require('../broker/files');
const deps = require('../deps');
const { shQuote, SH_QUOTE_ESCAPE, portablePath } = require('../shell-quote');
const { znCommand } = require('../zn-command');
const { hasUnsafeText } = require('../safe-text');

const SECRET_SOURCES = new Set(['exact', 'pattern']);
const POST_TOOLS = new Set(['read', 'bash', 'powershell', 'monitor', 'grep', 'lsp', 'webfetch', 'mcp', 'mcpresource']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const STREAM_JS = path.resolve(__dirname, '..', 'scrub', 'stream.js');

function readConfig(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home || os.homedir(), '.zn', 'config.json'), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

/*
 * What to do when the scrubber engine is missing from the installation:
 * "closed" (default) denies, withholds or blocks like any other error;
 * "open" lets events pass with a warning. Open is set only in
 * ~/.zn/config.json as {"hooks": {"whenUnavailable": "allow"}} (agents cannot
 * write there). ZN_HOOK_FAIL_MODE=closed in the environment makes it stricter;
 * ZN_HOOK_FAIL_MODE=open is ignored, because the agent's environment can be
 * set by the project it works in.
 */
function failModeOf(opts) {
  if (opts.failMode) return String(opts.failMode).toLowerCase() === 'open' ? 'open' : 'closed';
  if (String(process.env.ZN_HOOK_FAIL_MODE || '').toLowerCase() === 'closed') return 'closed';
  const hooks = readConfig(opts.home).hooks || {};
  const when = String(hooks.whenUnavailable || '').toLowerCase();
  if (when === 'allow') return 'open';
  if (when === 'deny') return 'closed';
  return String(hooks.failMode || '').toLowerCase() === 'open' ? 'open' : 'closed';
}

/*
 * Opt-in (off by default): when a tool output holds a real secret value, not
 * only a marker, zn also returns a stop reason for Codex's PostToolUse (see
 * respond() in lib/agents/codex.js). Set in ~/.zn/config.json as
 * {"hooks": {"replaceToolOutputOnSecret": true}}. Environment variables are not
 * read here: the project an agent works in can set them.
 */
function replaceOnSecretOf(opts) {
  const hooks = readConfig(opts.home).hooks || {};
  return hooks.replaceToolOutputOnSecret === true;
}

// Reinstall the running version: `npm install -g zn-gate` alone could install an
// older release without hooks.
const { version: ZN_VERSION } = require('../../package.json');
const REINSTALL = 'part of zn-gate is missing from this installation, so zn cannot check this action and blocked it. ' +
  'Ask the user to reinstall it with `npm install -g zn-gate@' + ZN_VERSION + '` and then run `zn hooks install`.';
// Only the person sees how to let actions pass unchecked; the model never gets that hint.
const REINSTALL_USER = 'part of zn-gate is missing from this installation, so zn blocks what it cannot check. ' +
  'Reinstall it with `npm install -g zn-gate@' + ZN_VERSION + '` and then run `zn hooks install`. ' +
  'To let actions pass unchecked until then, set {"hooks": {"whenUnavailable": "allow"}} in ~/.zn/config.json.';
/* Claude Code sets CLAUDE_PLUGIN_ROOT only for the hooks of a plugin: there `zn hooks install` does not apply. */
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor', opencode: 'OpenCode', antigravity: 'Antigravity' };
function fixHint(agentId) {
  if (agentId === 'claude-code' && process.env.CLAUDE_PLUGIN_ROOT) {
    return 'If it happens again, ask the user to update or reinstall the zn-gate plugin (`claude plugin update zn-gate@usezn`).';
  }
  const name = AGENT_NAMES[agentId];
  return 'If it happens again, ask the user to run `' + znCommand('hooks install' + (name ? ' ' + agentId : '')) + '`' +
    (name ? ' to set up zn for ' + name + ' again.' : '.');
}
const HOOK_FAILED = 'something went wrong inside the zn hook, so this action was blocked to keep the user\'s secrets safe. ';

/**
 * Refuse text that a native call could not survive (see safe-text.js) before any file, process or network call
 * sees it. The working directory and transcript path of every event are checked; a tool call, whose command and
 * paths the policy turns into file system calls, is checked whole.
 */
function guardNativeText(ev) {
  if (!(ev.event === 'pre_tool' ? hasUnsafeText(ev) : hasUnsafeEventPaths(ev))) return;
  const err = new Error('malformed text in the event');
  err.code = 'ZN_MALFORMED_TEXT';
  throw err;
}

// What the model wrote or read is content, never a path: a tool output, a prompt or an answer is checked by the
// scanner and does not reach a file call, so malformed text there is not a reason to refuse the event.
const CONTENT_KEYS = new Set(['prompt', 'tool_response', 'tool_output', 'output', 'result', 'response', 'last_assistant_message']);

/** Every other field of a post-tool, prompt or stop event (working directory, transcript, workspace roots, tool input) is checked. */
function hasUnsafeEventPaths(ev) {
  const input = ev.input && typeof ev.input === 'object' ? { ...ev.input, prompt: undefined } : ev.input;
  const raw = {};
  if (ev.raw && typeof ev.raw === 'object') {
    for (const [k, v] of Object.entries(ev.raw)) if (!CONTENT_KEYS.has(k) && v !== ev.output) raw[k] = v;
  }
  return hasUnsafeText([ev.cwd, ev.sessionId, ev.toolName, input, raw]);
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
  let vault = opts.vault === null ? null : opts.vault;
  return {
    engine() {
      if (!engine) engine = deps.loadEngine();
      return engine;
    },
    // A vault that cannot be loaded is null, never a reason to skip the
    // scrubber; the engine redacts irreversibly without it.
    async vault() {
      if (vault === undefined) {
        try {
          vault = await deps.loadVault();
        } catch (err) {
          if (err.code !== 'ZN_LOCKED') throw err;
          vault = null;
        }
      }
      return vault;
    },
  };
}

/**
 * The `zn run` prefix put in front of a Bash command that uses a secret. The
 * agent runs the rewritten command in bash (Claude Code's Bash tool, Git Bash
 * on Windows) or in the user's shell (OpenCode), so each path is one
 * single-quoted sh word and nothing in it is expanded.
 */
function znRunPrefix(opts, agentId) {
  if (opts.znRunPrefix) return opts.znRunPrefix;
  const q = (s) => shQuote(portablePath(s));
  const runJs = opts.runJs || path.resolve(__dirname, '..', 'broker', 'run.js');
  return 'ZN_AGENT=' + String(agentId).replace(/[^a-z0-9-]/g, '') + ' ' + q(opts.nodePath || process.execPath) + ' ' + q(runJs) + ' --';
}

/* Custom secret formats from the zn Team policy (verified cache), compiled
 * once per hook process. They only add redactions. */
let orgDetectors = null;
function orgDetectorsFor(opts) {
  if (orgDetectors === null) {
    try {
      const team = require('../team/policy');
      const { detectorsOf } = require('../team/effective');
      orgDetectors = require('../team/detectors').compile(detectorsOf(team.state({ home: opts && opts.znHome })));
    } catch (_) { orgDetectors = []; }
  }
  return orgDetectors;
}

async function ctxFor(ev, d, agentId, destination, needVault = true) {
  return {
    project: deps.findProjectRoot(ev.cwd || process.cwd()),
    agent: agentId,
    tool: ev.toolName || ev.tool,
    destination,
    vault: needVault ? await d.vault() : undefined,
    detectors: d.detectors ? d.detectors() : orgDetectorsFor(),
  };
}

/* ---------------------------- pre_tool ---------------------------- */

async function decidePre(ev, d, agentId, opts) {
  const pathOpts = { cwd: ev.cwd, home: opts.home };
  const input = ev.input || {};
  const tool = ev.tool;

  if (tool === 'read' || tool === 'lsp' || (tool === 'grep' && input.path)) {
    // An adapter that finds several paths in one call lists them all in input.paths.
    for (const p of Array.isArray(input.paths) && input.paths.length ? input.paths : [input.path]) {
      const deny = policy.readDenial(p, pathOpts);
      if (deny) return { decision: 'deny', message: deny };
    }
  }
  if (tool === 'grep' && input.scanDir) {
    // A search over a folder (or with no path) prints matching lines, and an agent that cannot redact that
    // output would show a plain-text secret to the model: ask when the folder holds a .env or a key file.
    let names = [];
    try { names = fs.readdirSync(input.scanDir).slice(0, 5000); } catch (_) { names = []; }
    for (const n of names) {
      if (policy.readDenial(path.join(input.scanDir, n), pathOpts)) {
        return { decision: 'ask', message: 'zn: this search covers a folder that holds ' + n + ', which has plain-text secrets, and matching lines are not hidden in this agent. Approve only if the search must include it, or name a narrower path.' };
      }
    }
  }
  if (tool === 'fileaccess') {
    // A tool zn does not know that names files: every path gets the read and the write checks.
    for (const p of Array.isArray(input.paths) ? input.paths : []) {
      const deny = policy.readDenial(p, pathOpts) || policy.writeDenial(p, pathOpts);
      if (deny) return { decision: 'deny', message: deny };
    }
    return { decision: 'allow' };
  }
  if (tool === 'write' || tool === 'edit' || tool === 'multiedit' || tool === 'notebookedit') {
    // A patch can touch several files: every one is checked, not only the first.
    if (input.tooLong) {
      return { decision: 'deny', message: 'zn: this patch is too long for zn to check (over 100 KB), so it was blocked. Next step: tell the user; do not resend it in parts.' };
    }
    if (input.unparsed) return { decision: 'deny', message: 'zn: could not read the file names in this patch, so zn cannot check it.' };
    for (const p of Array.isArray(input.paths) ? input.paths : [input.path]) {
      const deny = policy.writeDenial(p, pathOpts);
      if (deny) return { decision: 'deny', message: deny };
    }
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

  if (tool === 'monitor') return decideMonitor(ev, pathOpts, opts);
  if (tool === 'mcp' && Array.isArray(input.paths)) {
    // An MCP tool that takes a file path (a filesystem server): its output cannot be redacted in every agent.
    for (const p of input.paths) {
      const deny = policy.readDenial(p, pathOpts) || policy.writeDenial(p, pathOpts);
      if (deny) return { decision: 'deny', message: deny };
    }
  }
  if (tool === 'mcp' && ev.input && ev.input.args !== undefined) return decideMcp(ev, d, agentId);

  if (SHELL_TOOLS.has(tool)) {
    const original = String(input.command || '');
    const deny = policy.bashDenial(original, pathOpts);
    if (deny) return { decision: 'deny', message: deny };

    let command = original;
    const notes = [];
    const wrap = tool === 'powershell'
      ? policy.wrapPowerShell(command, { nodePath: opts.nodePath || process.execPath, runJs: opts.runJs || path.resolve(__dirname, '..', 'broker', 'run.js'), agent: agentId })
      : policy.wrapWithZnRun(command, znRunPrefix(opts, agentId));
    if (!wrap.ok) return { decision: 'deny', message: wrap.reason };
    if (wrap.wrapped) {
      command = wrap.command;
      notes.push('runs through zn run (zn\'s secret wrapper) for ' + markers.findNamedMarkers(original).map((m) => m.name).join(', ') +
        '; the first time, you approve the command, and secret values in its output stay hidden');
    }

    const detected = markers.findMarkers(command).filter((m) => m.detected);
    let context;
    if (detected.length) {
      const network = policy.hasNetworkSignals(command);
      const ctx = await ctxFor(ev, d, agentId, network ? 'bash_network' : 'bash_local');
      const res = await d.engine().detokenize(command, ctx);
      if (res && typeof res.text === 'string' && res.restored && res.restored.length) {
        command = res.text;
        notes.push('puts back ' + res.restored.length + ' hidden value(s) for a local command');
      }
      if (res && res.withheld && res.withheld.length) {
        notes.push('left ' + res.withheld.length + ' placeholder(s) unfilled: ' +
          res.withheld.map((w) => w.token + ' (' + w.reason + ')').join(', '));
        if (isOutdated(res.withheld)) {
          notes.push(outdatedLine().replace(/\.$/, ''));
          context = 'zn: ' + outdatedLine();
        }
      }
    }

    if (command === original) {
      if (markers.findMarkers(original).length) {
        // A command that carries markers always asks, even when nothing was rewritten
        // (already wrapped in `zn run` by the agent, or tokens kept unresolved).
        // Never let it run on the user's allow rules alone.
        return { decision: 'ask', message: 'zn: this command contains secret placeholders (such as __ZN_NAME__)' + (notes.length ? '; ' + notes.join('; ') : '') + ', so it needs your approval before it runs.', context };
      }
      return notes.length ? { decision: 'allow', message: 'zn: ' + notes.join('; ') } : { decision: 'allow' };
    }
    // kind tells adapters that cannot rewrite input what the rewrite was for.
    return { decision: 'ask', updatedInput: { command }, kind: wrap.wrapped ? 'wrap' : 'restore', message: 'zn: this command ' + notes.join('; ') + '.', context };
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
    const notices = new Set();
    for (const t of withMarkers) {
      const res = await d.engine().detokenize(t.value, ctx);
      if (res && res.restored && res.restored.length && res.text !== t.value) {
        updates.push({ key: t.key, value: res.text });
        restored += res.restored.length;
      }
      if (res && res.withheld) withheld.push(...res.withheld);
      if (res && Array.isArray(res.notices)) for (const n of res.notices) notices.add(n);
    }
    // Secrets the organization policy blocks: the file keeps the marker.
    const blocked = [...new Set(withheld.filter((w) => w.reason === 'org_deny').map((w) => w.token.slice(5, -2)))];
    const why = (withheld.length
      ? ' Kept as tokens: ' + [...new Set(withheld.map((w) => w.token))].join(', ') + (destination === 'write_tracked'
        ? ' (this file can be committed, so secrets stay as markers; put real values in a git-ignored file such as .env.local).'
        : '.')
      : '') +
      (blocked.length ? ' ' + blockedLine(blocked) : '') +
      (isOutdated(withheld) ? ' ' + outdatedLine() : '') +
      (notices.size ? ' ' + [...notices].join(' ') : '');
    // A secret the organization blocks: the write keeps the marker, and the
    // user is asked so the reason is shown (a plain allow shows nothing).
    // context: the model reads it, so it knows the value was not put back.
    const outdated = isOutdated(withheld);
    const told = [blocked.length ? blockedLine(blocked) : null, outdated ? outdatedLine() : null].filter(Boolean);
    const context = told.length ? 'zn: ' + told.join(' ') : undefined;
    if (updates.length === 0 && told.length) return { decision: 'ask', message: 'zn:' + why, context };
    if (updates.length === 0) return { decision: 'allow', message: why ? 'zn:' + why : undefined };
    return {
      decision: 'ask',
      updatedInput: { texts: updates },
      kind: 'restore',
      message: 'zn: restores ' + restored + ' secret value(s) in a git-ignored file.' + why,
      context,
    };
  }

  return { decision: 'allow' };
}

/* The vault process was started by an older zn-gate: it does not check the
 * organization policy, so nothing is put back until it is restarted. */
function outdatedLine() {
  return 'Your zn vault was started by an older zn-gate version, so secrets stay as markers. Run `' +
    znCommand('lock') + '`, then `' + znCommand('unlock') + '`.';
}
const isOutdated = (list) => (list || []).some((w) => w.reason === 'vault_outdated');

/* A secret the organization policy blocks (for every agent): the file keeps its marker. */
function blockedLine(names) {
  return 'Secret ' + names.join(', ') + (names.length > 1 ? ' are' : ' is') +
    ' blocked by your organization policy, so the file keeps the marker.';
}

/*
 * Monitor streams a command's output lines to the model as events that no
 * PostToolUse hook sees, so the command itself is rewritten to pipe through
 * the streaming scrubber (lib/scrub/stream.js). The rewrite is shown to the
 * user (ask). WebSocket monitors cannot be scrubbed and are refused.
 *
 * The original command runs as one argument of `bash -c` (single-quoted), so
 * nothing in it can close a group or end the pipeline early; pipefail keeps
 * its exit status. A command is left as it is only when it is exactly this
 * wrapper with our own node and stream.js paths; mentioning stream.js is not
 * enough.
 */
function monitorTail(opts) {
  const p = (s) => shQuote(portablePath(s));
  return ' 2>&1 | ' + p(opts.nodePath || process.execPath) + ' ' + p(STREAM_JS);
}

function wrapMonitor(original, opts) {
  return 'set -o pipefail; bash -c ' + shQuote(original) + monitorTail(opts);
}

function isMonitorWrapper(command, opts) {
  const head = 'set -o pipefail; bash -c \'';
  const tail = '\'' + monitorTail(opts);
  if (!command.startsWith(head) || !command.endsWith(tail)) return false;
  // The body must be one single-quoted word: a ' may appear in it only
  // within the escapes shQuote writes for a quote.
  const body = command.slice(head.length, command.length - tail.length);
  return body.replace(SH_QUOTE_ESCAPE, '').indexOf("'") === -1;
}

function decideMonitor(ev, pathOpts, opts) {
  const raw = (ev.raw && ev.raw.tool_input) || {};
  if (raw.ws !== undefined && raw.command === undefined) {
    return { decision: 'deny', message: 'zn: a WebSocket monitor sends its data to the model without the secret check. Next step: use a monitor that runs a command instead, because zn checks the output of commands.' };
  }
  const original = String(ev.input.command || '');
  if (original.length > policy.SHELL_SCAN_CAP) return { decision: 'deny', message: policy.bashDenial(original, pathOpts) };
  if (!original.trim()) return { decision: 'allow' };
  const deny = policy.bashDenial(original, pathOpts);
  if (deny) return { decision: 'deny', message: deny };
  if (markers.findMarkers(original).length) {
    return { decision: 'deny', message: 'zn: a monitor cannot use secret placeholders (such as __ZN_NAME__). Next step: run the command with the Bash tool instead; zn fills in the placeholders there.' };
  }
  if (isMonitorWrapper(original, opts)) return { decision: 'ask', message: 'zn: this monitor already checks its output for secrets.' };
  const command = wrapMonitor(original, opts);
  return { decision: 'ask', updatedInput: { command }, kind: 'monitor', message: 'zn: this monitor\'s output is checked on this computer before the model sees it. Secret values are replaced with placeholders such as __ZN_AWS_KEY_1__.' };
}

/*
 * MCP tool calls. Only Cursor sends the arguments (input.args); any other
 * agent's MCP pre-tool call is allowed before the vault is touched. The
 * arguments are checked for __ZN_ markers, which servers other than zn's own
 * never receive, and for credentials the scrubber finds, which no server
 * should receive from the agent. zn's "secrets" server takes markers by design,
 * but only when it is identified strictly (see isOurSecretsServer); it still
 * gets the credential check. A call with no objection gets no answer, so the
 * agent's own MCP approval still applies.
 */
const MCP_SCAN_CAP = 1024 * 1024; // characters, all arguments together
const MCP_WINDOW = 128 * 1024; // the scrubber reads the text in windows of this size
const MCP_OVERLAP = 16 * 1024; // windows overlap, so a secret across a boundary is seen whole

/* Every string of an MCP call's arguments (values and keys), joined with
 * newlines, or null when they hold more than MCP_SCAN_CAP characters. */
function mcpArgumentText(args) {
  const out = [];
  let total = 0;
  const stack = [args];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      total += v.length + 1;
      if (total > MCP_SCAN_CAP) return null;
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) stack.push(k, x);
    }
  }
  return out.join('\n');
}

/* zn's own "secrets" server: the exact command `zn hooks install` writes (the
 * matcher of `zn audit`, with the "--agent <id>" suffix it adds), outside the
 * project. A server reached by URL is never ours, and a name alone is not enough. */
function isOurSecretsServer(ev, root) {
  const raw = ev.raw || {};
  if (!ev.mcp || ev.mcp.server !== 'secrets') return false;
  if (raw.url || raw.mcp_server_url) return false;
  if (typeof raw.command !== 'string' || !raw.command.trim()) return false;
  const argv = require('../audit/patterns').splitCommand(raw.command);
  return Boolean(require('../audit')._internal.isOurMcp(argv, { rec: { root } }));
}

/* Server names come from the agent's config: keep the message to plain characters. */
function mcpServerLabel(server) {
  const s = String(server || '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 64).trim();
  return s ? 'the MCP server ' + s : 'an MCP server';
}

async function decideMcp(ev, d, agentId) {
  const text = mcpArgumentText(ev.input.args);
  if (text === null) {
    return { decision: 'deny', message: 'zn: this MCP call is too large for zn to check (its arguments are over 1 MB). Next step: tell the user; do not resend this content in parts.' };
  }
  if (!text) return { decision: 'allow' }; // nothing to check, so the vault is not loaded
  const server = ev.mcp && ev.mcp.server ? String(ev.mcp.server) : '';
  const ours = isOurSecretsServer(ev, deps.findProjectRoot(ev.cwd || process.cwd()));
  if (!ours && markers.findMarkers(text).length) {
    return {
      decision: 'deny',
      message: 'zn: ' + mcpServerLabel(server) + ' never receives secret values, so zn blocked this call. ' +
        'Next step: for an authenticated web request, use the secrets_http_request tool of the zn "secrets" MCP server; otherwise remove the placeholder from the call.',
    };
  }

  const engine = d.engine();
  let ctx = await ctxFor(ev, d, agentId, 'mcp_input');
  if (typeof engine.prepare === 'function') ctx = await engine.prepare(ctx);
  const kinds = new Set();
  for (let start = 0; ; start += MCP_WINDOW - MCP_OVERLAP) {
    for (const span of engine.scan(text.slice(start, start + MCP_WINDOW), ctx) || []) {
      if (SECRET_SOURCES.has(span.source)) kinds.add(kindLabel(span.type));
    }
    if (start + MCP_WINDOW >= text.length) break;
  }
  if (kinds.size === 0) return { decision: 'allow' };
  return {
    decision: 'deny',
    kinds: [...kinds],
    message: 'zn: this call would send a secret (' + [...kinds].join(', ') + ') to ' + mcpServerLabel(server) + ', so zn blocked it. ' +
      'A stored secret cannot be passed to this server. ' +
      'Next step: for a web request, use the secrets_http_request tool of the zn "secrets" MCP server, which sends the stored value itself; do not put the value in this call.',
  };
}

/* ---------------------------- post_tool --------------------------- */

async function decidePost(ev, d, agentId, opts = {}) {
  if (!POST_TOOLS.has(ev.tool)) return { decision: 'allow' };
  if (agentId === 'codex' && ev.tool === 'bash') {
    // Codex runs every PreToolUse hook at once with the original call, so another tool's hook can change the
    // command after zn checked it. PostToolUse carries the command that really ran: if zn blocks that one,
    // the output is withheld. The command has already run, so this limits what the model sees, not what happened.
    const denial = policy.bashDenial(String(ev.input.command || ''), { cwd: ev.cwd, home: opts.home });
    if (denial) {
      return { decision: 'deny', message: 'zn: A command different from the one zn checked was run (another tool changed it). zn withheld its output because zn blocks that command. Review the other hooks configured for Codex.' };
    }
  }
  if (ev.output === undefined || ev.output === null) return { decision: 'allow' };
  const engine = d.engine();
  const ctx = await ctxFor(ev, d, agentId, 'assistant');
  const types = new Map();
  const secretKinds = new Set();
  let locked = false;
  const updated = await mapStrings(ev.output, async (s) => {
    if (s.length < 8) return s;
    const res = await engine.tokenize(s, ctx);
    if (!res || typeof res.text !== 'string') throw deps.znError('ZN_ENGINE', 'tokenize returned an unexpected shape');
    if (res.locked) locked = true;
    for (const r of res.replaced || []) {
      types.set(r.type, (types.get(r.type) || 0) + 1);
      if (SECRET_SOURCES.has(r.source)) secretKinds.add(kindLabel(r.type));
    }
    return res.text;
  });
  if (types.size === 0) return { decision: 'allow' };
  const total = [...types.values()].reduce((a, b) => a + b, 0);
  const summary = [...types.entries()].map(([t, n]) => t + (n > 1 ? ' x' + n : '')).join(', ');
  const out = {
    decision: 'allow',
    stats: { redacted: total, detections: Object.fromEntries(types) },
    updatedOutput: updated,
    message: 'zn: ' + total + ' secret value(s) in this output were replaced with __ZN_ tokens (' + summary + '). ' +
      (locked ? '__ZN_REDACTED_ markers cannot be restored, so do not retry to get the values. ' : 'Real values stay on this machine; use the tokens as they are.'),
    userMessage: locked ? lockedNotice() : undefined,
  };
  // Opt-in, Codex only (respond() in lib/agents/codex.js): a real secret value also gets a stop reason.
  if (agentId === 'codex' && secretKinds.size > 0 && replaceOnSecretOf(opts)) {
    out.stopReason = 'zn: this tool output contained ' + [...secretKinds].join(', ') +
      '. zn replaced it with a token. Stop and ask the user to review the output, and to rotate the value if it is real, before you continue.';
  }
  return out;
}

/* Shown to the person (systemMessage) when the vault is locked. */
function lockedNotice() {
  return 'zn hid secret values in this output. Your vault is locked, so they cannot be put back afterwards. ' +
    'To keep them restorable next time, unlock it in your terminal: ' + znCommand('unlock');
}

/* --------------------------- user_prompt -------------------------- */

async function decidePrompt(ev, d, agentId) {
  return decidePromptText(ev, d, agentId, false);
}

// The expanded text of a skill or command: the same checks as a typed prompt,
// plus private keys, and a size cap so the check fits in the hook's time.
const EXPANSION_CAP = 1000000;
const PRIVATE_KEY_HEADER_RE = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_BODY_RE = /^\s*(?:[ \t]*[A-Za-z0-9+\/=]{8,}[ \t]*\r?\n){2}|^\s*[A-Za-z0-9+\/=]{64,}/;

// A key, not a line that names one: the header must be followed by a base64 body.
function hasPrivateKey(text) {
  if (/PuTTY-User-Key-File-/.test(text)) return true;
  PRIVATE_KEY_HEADER_RE.lastIndex = 0;
  let m;
  while ((m = PRIVATE_KEY_HEADER_RE.exec(text)) !== null) {
    if (PRIVATE_KEY_BODY_RE.test(text.slice(m.index + m[0].length, m.index + m[0].length + 4096))) return true;
  }
  return false;
}

async function decideExpansion(ev, d, agentId) {
  return decidePromptText(ev, d, agentId, true);
}

async function decidePromptText(ev, d, agentId, expansion) {
  const prompt = String((ev.input && ev.input.prompt) || '');
  if (expansion && prompt.length > EXPANSION_CAP) {
    return {
      decision: 'deny',
      message: 'zn: this command was not run because its expanded text is too long to check for secrets in time. ' +
        'Use a shorter skill or command, or point it at a file the agent reads (zn checks that read).',
    };
  }
  if (expansion && hasPrivateKey(prompt)) {
    return {
      decision: 'deny',
      stats: { detections: { PRIVATE_KEY: 1 } },
      message: 'zn: this command was not run because it would put a private key in front of the model. ' +
        'Remove the key from the skill or command (or from the file it includes), then run it again.',
    };
  }
  if (prompt.length < 8) return { decision: 'allow' };
  const engine = d.engine();
  let ctx = await ctxFor(ev, d, agentId, 'assistant');
  // scan() is pure: prepare() first fetches the vault's exact values (and
  // local ones), so a pasted vault secret is caught even without a pattern.
  if (typeof engine.prepare === 'function') ctx = await engine.prepare(ctx);
  const spans = engine.scan(prompt, ctx) || [];
  const secrets = spans.filter((s) => SECRET_SOURCES.has(s.source));
  // Prompts only: NAME=value in the middle of a sentence, even when the value
  // does not look random (see lib/scrub/prompt.js).
  for (const a of require('../scrub/prompt').findPromptAssignments(prompt)) {
    if (!secrets.some((s) => s.start < a.end && a.start < s.end)) secrets.push(a);
  }
  if (secrets.length === 0) return { decision: 'allow' };
  const others = [...spans, ...secrets];
  const scanText = (t) => { try { return engine.scan(t, ctx) || []; } catch (_) { return []; } };
  const names = secrets.map((s) => nameOf(s) || keyBefore(prompt, s, others, scanText));
  const shown = [...new Set(secrets.map((s, i) => names[i] || kindLabel(s.type)))];
  const suggestion = names[0] || suggestedName(secrets[0]);
  const stats = { detections: Object.fromEntries([...new Set(secrets.map((s) => s.type || 'SECRET'))].map((k) => [k, 1])) };
  if (expansion) {
    return {
      decision: 'deny',
      stats,
      message: 'zn: this command was not run because its expanded text contains a secret value (' + shown.join(', ') + '). ' +
        'Remove the value from the skill or command, or from the file it includes (a .env with values, a credential file). ' +
        'To use the secret, save it in your vault: ' + znCommand('secret set ' + suggestion) + ', and refer to it as __ZN_' + suggestion + '__.',
    };
  }
  return {
    decision: 'deny',
    stats,
    message: 'zn: this prompt was not sent because it contains a secret (' + shown.join(', ') + '). ' +
      'Save it in your vault instead: ' + znCommand('secret set ' + suggestion) +
      ', then ask your agent to use it (as __ZN_' + suggestion + '__).',
  };
}

// A vault name: upper case, at most 64 characters. A JSON key such as
// "db_password" is shown as DB_PASSWORD; anything else falls back to the kind.
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const GENERIC_TYPES = new Set(['SECRET', 'CREDENTIAL']);

function nameOf(span) {
  const n = String(span.name || '').toUpperCase();
  return NAME_RE.test(n) ? n : null;
}

// Words that keep their usual capitals in a message a person reads.
const ACRONYMS = new Set(['AWS', 'API', 'SSH', 'JWT', 'SSN', 'NIE', 'DNI', 'IBAN', 'PAT', 'DB', 'PII', 'URL', 'GCP', 'OAUTH', 'TLS', 'SSL', 'SMTP']);
const BRANDS = {
  ANTHROPIC: 'Anthropic', AZURE: 'Azure', DATABRICKS: 'Databricks', DIGITALOCEAN: 'DigitalOcean', DISCORD: 'Discord',
  DOCKERHUB: 'Docker Hub', GITHUB: 'GitHub', GITLAB: 'GitLab', GOOGLE: 'Google', MAILGUN: 'Mailgun', NEWRELIC: 'New Relic',
  NPM: 'npm', OPENAI: 'OpenAI', PYPI: 'PyPI', REPLICATE: 'Replicate', SENDGRID: 'SendGrid', SHOPIFY: 'Shopify',
  SLACK: 'Slack', STRIPE: 'Stripe', SUPABASE: 'Supabase', TELEGRAM: 'Telegram', TWILIO: 'Twilio', XAI: 'xAI',
};

/* "AWS_KEY" -> "an AWS key", "GITHUB_TOKEN" -> "a GitHub token", for a message
 * a person reads. Only known acronyms and brands get capitals. */
function kindLabel(type) {
  const words = String(type || '').split(/_+/).filter(Boolean).map((w) => {
    const u = w.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(BRANDS, u)) return BRANDS[u];
    if (ACRONYMS.has(u)) return u;
    return w.toLowerCase();
  });
  const label = words.join(' ') || 'secret';
  return (/^([AEIOU]|AWS\b|API\b|SSH\b|SSN\b|IBAN\b|OAUTH\b)/i.test(label) ? 'an ' : 'a ') + label;
}

// A generic detection has no name of its own. The credential name written just
// before the value ("db_password = ...", "-e API_KEY=...") is the kind a person
// can recognise. Only the text before the value is read, never the value.
const KEY_BEFORE_RE = /([A-Za-z_][A-Za-z0-9_.-]{0,127})["'`]?[ 	]*(?:=>|:=|=|:)[ 	]*["'`]?[ 	]*$/;
const KEY_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// The text before a value can be another secret ("<id>:<secret>"). It is used
// as a name only if it overlaps no other detection, looks like a key
// identifier (not a random token) and is not itself detected as a secret.
function keyBefore(text, span, others, scanText) {
  if (span.name || !GENERIC_TYPES.has(String(span.type || '').toUpperCase())) return null;
  const from = Math.max(0, span.start - 140);
  const m = KEY_BEFORE_RE.exec(String(text).slice(from, span.start));
  if (!m) return null;
  const raw = m[1];
  const start = from + m.index;
  const end = start + raw.length;
  if ((others || []).some((o) => o !== span && o.start < end && start < o.end)) return null;
  if (!KEY_IDENT_RE.test(raw)) return null;
  if (/\d/.test(raw) && /[a-z]/.test(raw) && /[A-Z]/.test(raw)) return null;
  if ((raw.match(/\d/g) || []).length > 3) return null;
  if (scanText && scanText(raw).length > 0) return null;
  const n = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toUpperCase();
  return NAME_RE.test(n) ? n : null;
}

/* The name to suggest for `zn secret set` when the detection has no name. */
function suggestedName(span) {
  const t = String(span.type || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_\d+$/, '');
  return t && !GENERIC_TYPES.has(t) ? t : 'MY_SECRET';
}

/* ------------------------------- stop ------------------------------ */

// Codex's Stop hook reads the model's final answer. Default: a warning only.
// "hooks": {"stopReview": "block"} in ~/.zn/config.json asks the agent to
// rewrite it. zn never blocks when the agent already continues because of a
// Stop hook (stopHookActive), so the check cannot loop.
const STOP_TRANSCRIPT_CAP = 64 * 1024 * 1024;

function stopReviewMode(opts) {
  const hooks = readConfig(opts.home).hooks || {};
  return String(hooks.stopReview || '').toLowerCase() === 'block' ? 'block' : 'warn';
}

// Transcripts are streamed in chunks of this size; the heap stays small
// whatever the file size, though process memory still grows with it. Above
// STOP_TRANSCRIPT_CAP the check is skipped.
const STOP_CHUNK_BYTES = 256 * 1024;

// Non-overlapping occurrences, the same count as split(needle).length - 1.
function countIn(text, needle) {
  return text.split(needle).length - 1;
}

// Markers in the answer that appear nowhere else in the transcript (no prompt,
// no tool output, no earlier message). The answer itself is counted out, and so
// is every verbatim copy of it: Codex writes its final answer to the session log
// more than once (3 times on 0.163.0), so subtracting a single copy would hide a
// placeholder that only the answer contains. A copy is the answer as the log
// writes it in JSON; when none is found (a different escaping) one copy is
// assumed, which is the earlier behaviour. The transcript is streamed, so the
// whole file is read, up to STOP_TRANSCRIPT_CAP. An unreadable or larger-than-cap
// transcript skips this check. A marker repeated in an answer whose transcript
// lacks that answer can be reported falsely.
const STOP_COPY_CAP = 1024 * 1024; // answers longer than this (as JSON) are counted as one copy

async function unseenMarkers(message, transcriptPath) {
  const found = [...new Set(markers.findMarkers(message).map((m) => m.marker))];
  if (found.length === 0 || !transcriptPath) return [];
  try {
    if (fs.statSync(transcriptPath).size > STOP_TRANSCRIPT_CAP) return [];
    // Markers are ASCII, so they are searched as bytes: no UTF-8 decoding per chunk.
    // The answer copy is searched the same way, as the bytes of its JSON string body.
    const copyBytes = Buffer.from(JSON.stringify(message).slice(1, -1), 'utf8');
    const copyKey = '\u0000answer';
    const keys = found.slice();
    const needle = {};
    for (const m of found) needle[m] = Buffer.from(m, 'utf8');
    if (copyBytes.length > 0 && copyBytes.length <= STOP_COPY_CAP) {
      keys.push(copyKey);
      needle[copyKey] = copyBytes;
    }
    const count = {};
    const lastEnd = {}; // absolute offset just past the last counted occurrence
    for (const k of keys) {
      count[k] = 0;
      lastEnd[k] = 0;
    }
    // Each chunk is searched in place. Only a needle that straddles two chunks
    // needs a joined window, so no chunk is copied.
    const scan = (buf, absBase) => {
      for (const k of keys) {
        for (let i = buf.indexOf(needle[k]); i !== -1; i = buf.indexOf(needle[k], i + 1)) {
          const abs = absBase + i;
          if (abs >= lastEnd[k]) {
            count[k] += 1;
            lastEnd[k] = abs + needle[k].length;
          }
        }
      }
    };
    const keep = Math.max(...keys.map((k) => needle[k].length)) - 1;
    let carry = Buffer.alloc(0); // last bytes of the previous chunk
    let carryAbs = 0; // absolute offset of carry[0]
    let chunkAbs = 0; // absolute offset of the next chunk
    const stream = fs.createReadStream(transcriptPath, { highWaterMark: STOP_CHUNK_BYTES });
    for await (const chunk of stream) {
      if (carry.length) scan(Buffer.concat([carry, chunk.subarray(0, keep)]), carryAbs);
      scan(chunk, chunkAbs);
      carry = chunk.subarray(Math.max(0, chunk.length - keep));
      carryAbs = chunkAbs + chunk.length - carry.length;
      chunkAbs += chunk.length;
    }
    const copies = Math.max(1, count[copyKey] || 0);
    // The marker may sit inside a copy more than once; each copy accounts for that many.
    return found.filter((m) => count[m] - copies * countIn(message, m) <= 0);
  } catch (_) {
    return [];
  }
}

async function decideStop(ev, d, agentId, opts) {
  const message = String((ev.input && ev.input.message) || '');
  const stopHookActive = Boolean(ev.input && ev.input.stopHookActive);
  const kinds = new Set();
  if (message.length >= 8) {
    const engine = d.engine();
    let ctx = await ctxFor(ev, d, agentId, 'assistant');
    if (typeof engine.prepare === 'function') ctx = await engine.prepare(ctx);
    for (const span of engine.scan(message, ctx) || []) {
      if (SECRET_SOURCES.has(span.source)) kinds.add(kindLabel(span.type));
    }
  }
  const stray = await unseenMarkers(message, ev.input && ev.input.transcriptPath);
  if (kinds.size === 0 && stray.length === 0) return { decision: 'allow' };
  const found = [
    ...(kinds.size ? ['a secret value (' + [...kinds].join(', ') + ')'] : []),
    ...(stray.length ? ['a placeholder zn did not see earlier in this session (' + stray.join(', ') + ')'] : []),
  ].join(' and ');
  if (stopReviewMode(opts) === 'block' && !stopHookActive) {
    return {
      decision: 'deny',
      message: 'zn: your last answer contains ' + found + '. Rewrite it without that value or placeholder: ' +
        'do not repeat the value, and refer to a stored secret only by a placeholder that you got from a tool or from the user.',
      notice: 'zn: the last answer contains ' + found + '. zn asked the agent to rewrite it.',
    };
  }
  const notice = stopHookActive
    ? 'zn: the last answer still contains ' + found + '. zn does not block a second time, so check it before you share it.'
    : 'zn: the last answer contains ' + found + '. zn did not stop it. To have zn ask the agent to rewrite such answers, ' +
      'set "stopReview" to "block" under "hooks" in ~/.zn/config.json.';
  return { decision: 'ask', notice };
}

/* ------------------------------ entry ----------------------------- */

function failDecision(ev, err, mode, agentId) {
  // A Stop check never blocks because zn failed: that could keep the agent going.
  if (ev && ev.event === 'stop') {
    return { decision: 'ask', failOpen: true, notice: 'zn: could not check the last answer for secrets' + (err && err.code ? ' (' + err.code + ')' : '') + '.' };
  }
  if (err.code === 'ZN_MALFORMED_TEXT') {
    return failClosed(ev, err, 'zn: this action names a file or text that is not valid Unicode text, so it was blocked. ' +
      'Ask the user to check the file names in the request.');
  }
  const missing = err.code === 'ZN_UNAVAILABLE';
  const detail = missing ? '' : ' (' + (err.code ? err.code + ': ' : '') + String(err.message || 'unknown error') + ')';
  const msg = 'zn: ' + (missing ? REINSTALL : HOOK_FAILED + fixHint(agentId)) + detail;
  // Fail open only when the engine itself is missing and the user chose so.
  if (mode === 'open' && missing) return { decision: 'allow', failOpen: true, warning: 'zn: ' + REINSTALL_USER };
  const r = failClosed(ev, err, msg);
  // The user (not only the model) needs to hear how to fix a broken install.
  if (missing) r.userMessage = 'zn: ' + REINSTALL_USER;
  return r;
}

function failClosed(ev, err, msg) {
  if (ev && ev.event === 'post_tool' && ev.output !== undefined) {
    const withheld = '[zn: this output was hidden because zn could not check it for secrets (' + (err.code || 'error') + ')]';
    const shape = (v) => (typeof v === 'string' ? withheld
      : Array.isArray(v) ? v.map(shape)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v);
    return { decision: 'allow', updatedOutput: shape(ev.output), message: msg };
  }
  if (ev && ev.event === 'pre_tool') return { decision: 'deny', failClosed: true, message: msg };
  return { decision: 'deny', failClosed: true, message: msg, userMessage: msg };
}

/*
 * Context for the model when a session or a subagent starts (Codex SessionStart
 * and SubagentStart). Short on purpose: it is added to every session.
 */
function SESSION_CONTEXT() {
  return 'zn is on in this project: it blocks reads of .env files and of the secrets vault. ' +
    'To run a command that needs a stored secret, write the placeholder __ZN_<NAME>__ and run the command with `' + znCommand('run -- <command>') + '`.';
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
    if (ev && ev.event) guardNativeText(ev);
    if (!ev || !ev.event) decision = { decision: 'allow' };
    else if (ev.event === 'pre_tool') decision = await decidePre(ev, d, adapter.id, opts);
    else if (ev.event === 'post_tool') decision = await decidePost(ev, d, adapter.id, opts);
    else if (ev.event === 'user_prompt') decision = await decidePrompt(ev, d, adapter.id);
    else if (ev.event === 'stop') decision = await decideStop(ev, d, adapter.id, opts);
    else if (ev.event === 'session_start') decision = { decision: 'allow', context: SESSION_CONTEXT() };
    else if (ev.event === 'prompt_expansion') decision = await decideExpansion(ev, d, adapter.id);
    else decision = { decision: 'allow' };
  } catch (err) {
    decision = failDecision(ev, err, mode, adapter.id);
  }
  const output = adapter.respond({ ...decision, event: ev });
  countHook(adapter.id, ev, decision, opts);
  recordEvidence(adapter.id, ev, decision, opts);
  return { output, stderr: decision.warning || null, decision };
}

/**
 * Local counts for `zn-gate stats` (best effort; never changes the decision). A denial because zn itself
 * failed (fail-closed) is not counted as a block; asks and fail-open passes count as warnings.
 */
function countHook(agentId, ev, decision, opts = {}) {
  try {
    if (!ev || !ev.event || !decision) return;
    // Codex asks PreToolUse first, then PermissionRequest for the same call when it shows an approval prompt.
    // The check runs twice but the call is one call: count it at PreToolUse only.
    if (ev.permissionRequest) return;
    // A reminder at the start of a session checks nothing: it is not counted.
    if (ev.event === 'session_start') return;
    if (ev.event === 'stop') {
      // A check of the final answer is not a tool check: it has its own counters.
      const statsFile = opts.home ? path.join(opts.home, '.zn', 'stats.json') : undefined;
      const stats = require('../stats');
      stats.recordEvent('stop-review', statsFile ? { file: statsFile } : {});
      if (decision.decision !== 'allow') stats.recordEvent('stop-review-flagged', statsFile ? { file: statsFile } : {});
      return;
    }
    const extra = decision.stats || {};
    const file = opts.home ? path.join(opts.home, '.zn', 'stats.json') : undefined;
    require('../stats').record({
      layer: 'hook', agent: agentId, checked: 1,
      blocked: decision.decision === 'deny' && !decision.failClosed ? 1 : 0,
      warned: decision.decision === 'ask' || decision.failOpen ? 1 : 0,
      redacted: extra.redacted || 0,
      detections: extra.detections || {},
    }, file ? { file } : {});
  } catch {
    /* counting must never affect a hook */
  }
}

/**
 * Puts a hook block (and a redaction of tool output) in the hash-chained evidence ledger, so
 * `zn-gate evidence` shows it. It writes: the agent, the event, the tool name, a rule id and the
 * kinds of secret found. It never writes a secret value, a path, a command or prompt text. Only
 * blocks and redactions are written (an allow, the common case, costs nothing), and the ledger
 * code is loaded only then. A problem with the ledger is reported on stderr by the ledger itself
 * and never changes the decision: the answer is already built when this runs.
 */
function recordEvidence(agentId, ev, decision, opts = {}) {
  try {
    if (!ev || !ev.event || !decision || ev.permissionRequest) return;
    const denied = decision.decision === 'deny' && !decision.failClosed;
    const stats = decision.stats || {};
    const redacted = ev.event === 'post_tool' && decision.decision === 'allow' && stats.redacted > 0;
    if (!denied && !redacted) return;
    const kinds = Object.keys(stats.detections || {}).concat(Array.isArray(decision.kinds) ? decision.kinds : [])
      .filter((k, i, a) => typeof k === 'string' && /^[A-Za-z0-9_ .-]{1,64}$/.test(k) && a.indexOf(k) === i).sort();
    const evidence = require('../evidence');
    const file = opts.home ? path.join(opts.home, '.zn', 'evidence.jsonl') : undefined;
    evidence.logEvidence({
      agent: agentId,
      phase: redacted ? 'tool-result' : 'hook-' + ev.event,
      tool_name: ev.tool || ev.event,
      // Only the shape of the event is hashed and previewed, never its content.
      payload: JSON.stringify({ event: ev.event, tool: ev.tool || null, kinds }),
      verdict: redacted ? 'allow' : 'block',
      rule: redacted ? 'hook-redacted-output' : 'hook-' + ev.event + (kinds.length ? '-secret' : '-policy'),
      reason: redacted
        ? stats.redacted + ' secret value(s) in the tool output replaced with tokens' + (kinds.length ? ' (' + kinds.join(', ') + ')' : '')
        : (kinds.length ? 'secret kinds: ' + kinds.join(', ') : 'blocked by the zn hook policy'),
      engine: 'zn-hook',
    }, file, { lockWaitMs: 500, noStats: true });
  } catch (e) {
    try { process.stderr.write('zn-gate: could not record the block in the evidence log (' + (e && e.code || 'error') + ').' + String.fromCharCode(10)); } catch (_) { /* nothing more to do */ }
  }
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

/*
 * An event that cannot be read cannot be checked, so it is refused. Letting
 * it pass is a silent fail-open: the byte order mark of PowerShell did exactly
 * that until it was fixed. Exit code 2 blocks the call in Claude Code and
 * Codex (their documented block code for these events); Cursor documents exit
 * 2 as deny for preToolUse, beforeShellExecution and beforeReadFile, and its
 * deny answer is printed too, which covers beforeSubmitPrompt. With
 * hooks.whenUnavailable "allow" in ~/.zn/config.json, such events pass, as
 * they do when the engine is missing.
 */
function refuseInput(agentId, why) {
  if (failModeOf({}) === 'open') {
    process.stderr.write('zn hook: ' + why + '; passed through (hooks.whenUnavailable is "allow")\n');
    // Antigravity denies the call when the hook prints nothing, so passing it through takes an explicit answer.
    if (agentId === 'antigravity') process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }
  // Claude Code and Codex show this stderr to the model, so it never says how to
  // let actions pass unchecked (docs/compat.md documents that for the user).
  const msg = 'zn: could not read this action (' + why + '), so it was blocked. ' + fixHint(agentId);
  process.stderr.write('zn hook: ' + msg + '\n');
  if (agentId === 'cursor') process.stdout.write(JSON.stringify({ permission: 'deny', continue: false, user_message: msg, agent_message: msg }));
  // Antigravity does not document its exit codes, so its deny answer is printed as well.
  if (agentId === 'antigravity') process.stdout.write(JSON.stringify({ decision: 'deny', reason: msg }));
  // Copilot CLI: exit 2 denies preToolUse (other events only warn); the documented deny answer is printed as well.
  if (agentId === 'copilot') process.stdout.write(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: msg }));
  // Gemini CLI documents exit 2 as a block with stderr as the reason, so it needs no JSON on stdout (stdout that
  // is not JSON counts as allow there); any other exit code only warns and lets the tool run.
  process.exitCode = 2;
}

async function main(args, readText = readStdin) {
  const state = { stopEvent: false };
  try {
    await handleEvent(args, state, readText);
  } catch (err) {
    if (state.stopEvent) return stopFailSafe(err);
    // Anything unexpected fails closed: the call is refused, not passed through.
    refuseInput(args[0], 'the hook failed (' + ((err && err.message) || String(err)) + ')');
  }
}

/*
 * An internal error while handling a Stop event must never exit 2: Codex and
 * Claude Code read exit 2 on Stop as "keep going", which would send the
 * answer back to the model. Warn the user instead and exit 0 with a
 * systemMessage (a warning only, which the Stop output schema allows). The
 * error text is not printed: it may carry content from the event.
 */
function stopFailSafe(err) {
  const code = (err && err.code) || 'internal error';
  process.stderr.write('zn hook: could not check the last answer (' + code + ')\n');
  process.stdout.write(JSON.stringify({ systemMessage: 'zn: could not check the last answer for secrets (' + code + ').' }));
}

async function handleEvent(args, state, readText) {
  const agentId = args[0];
  let adapter;
  try {
    adapter = require('../agents').getAdapter(agentId);
  } catch (err) {
    process.stderr.write('zn hook: ' + err.message + '\n');
    process.exitCode = 1;
    return;
  }
  // Windows PowerShell 5.1 writes a byte order mark when it pipes text to a
  // native command, which JSON.parse rejects.
  const text = (await readText()).replace(/^﻿/, '');
  if (!text.trim()) return refuseInput(agentId, 'stdin was empty');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // A Stop event is never blocked here: exit 2 would make the agent continue the answer.
    if (/"hook_event_name"\s*:\s*"Stop"/.test(text)) {
      process.stderr.write('zn hook: could not read this Stop event, so the last answer was not checked\n');
      return;
    }
    // Node's parse error quotes part of the input, which can be tool output: never pass it on.
    return refuseInput(agentId, 'the event on stdin is not valid JSON');
  }
  // Valid JSON that is not an object (a number, a string, an array) is not an event.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuseInput(agentId, 'the event on stdin is not a JSON object');
  }
  state.stopEvent = raw.hook_event_name === 'Stop';
  const res = await handle(adapter, raw);
  if (res.stderr) process.stderr.write(res.stderr + ' (fail-open: event passed through)\n');
  try { require('../vault/client').close(); } catch (_) { /* not loaded */ }
  if (res.output !== null && res.output !== undefined) process.stdout.write(JSON.stringify(res.output));
}

module.exports = { handle, main, mapStrings, decidePre, decidePost, decidePrompt, decideExpansion, decideStop };

// Direct entry (`node lib/hooks/runner.js <agent>`): what installed hooks call,
// so a hook does not pay for loading the rest of the CLI.
if (require.main === module) main(process.argv.slice(2));
