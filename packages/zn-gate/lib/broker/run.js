'use strict';

/**
 * zn run [--secrets A,B] -- <command> [args...]
 *
 * Env mode of the secrets broker (the MVP has no egress proxy):
 *   - Named markers (__ZN_<NAME>__) in the child's arguments and environment
 *     are replaced by the real values, and --secrets NAME sets env NAME=value.
 *     Nothing else is changed: values only ever exist inside the child.
 *   - Only for secrets in mode "env" whose allowCommands matches the command.
 *   - The first use of each (secret, command) pair needs your confirmation
 *     at a terminal.
 *   - The child's stdout/stderr are masked: the value and its base64, hex
 *     and url-encoded forms are printed as the marker.
 *   - Fail-closed: any policy or vault error stops before the child starts.
 *
 * Commands that only need a secret for an HTTP call should use the
 * secrets_http_request MCP tool instead: there the request is made by zn
 * and only goes to the secret's allowHosts.
 */

const { spawn } = require('child_process');
const path = require('path');
const markers = require('./markers');
const { createMasker } = require('./mask');
const { approvalStore } = require('./approvals');
const tty = require('./tty');
const { znError, loadVault, findProjectRoot } = require('../deps');

const USAGE = 'usage: zn run [--secrets NAME[,NAME...]] -- <command> [args...]';

function splitList(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parseRunArgs(args) {
  const secrets = [];
  let i = 0;
  let sawDashDash = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; sawDashDash = true; break; }
    if (a === '--secrets' || a === '-s') {
      const v = args[++i];
      if (!v) throw znError('ZN_USAGE', USAGE);
      secrets.push(...splitList(v));
    } else if (a.startsWith('--secrets=')) {
      secrets.push(...splitList(a.slice('--secrets='.length)));
    } else {
      throw znError('ZN_USAGE', 'unexpected argument before --: ' + a + '\n' + USAGE);
    }
  }
  const command = sawDashDash ? args.slice(i) : [];
  if (command.length === 0) throw znError('ZN_USAGE', USAGE);
  for (const name of secrets) {
    const bad = markers.validateSecretName(name);
    if (bad) throw znError('ZN_USAGE', 'invalid secret name ' + JSON.stringify(name) + ': ' + bad);
  }
  return { secrets: [...new Set(secrets)], command };
}

/** Named secrets the command needs: markers in argv plus --secrets. */
function requiredSecrets(parsed) {
  const names = new Set(parsed.secrets);
  for (const a of parsed.command) for (const m of markers.findNamedMarkers(a)) names.add(m.name);
  return [...names];
}

/**
 * Named markers that only appear in inherited environment values (for
 * example a shadowed .env loaded by direnv). They are optional: injected when
 * the secret already allows and approved this command, left as markers
 * otherwise, so unrelated commands keep working.
 */
function optionalSecrets(parsed, env) {
  const required = new Set(requiredSecrets(parsed));
  const names = new Set();
  for (const v of Object.values(env || {})) {
    for (const m of markers.findNamedMarkers(v)) if (!required.has(m.name)) names.add(m.name);
  }
  return [...names];
}

function referencedSecrets(parsed, env) {
  return [...requiredSecrets(parsed), ...optionalSecrets(parsed, env)];
}

function cmdQuote(arg) {
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

/**
 * Decide and resolve. Returns {argv, env, secrets: [{name, mode, command, value}]}
 * or throws ZN_POLICY_DENIED / ZN_NOT_FOUND / ZN_LOCKED.
 */
async function prepare(parsed, opts) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const project = opts.project || findProjectRoot(cwd);
  const vault = opts.vault;
  const agent = opts.agent || env.ZN_AGENT || null;
  const argv0 = parsed.command[0];
  const exe = markers.normalizeExe(argv0);
  const names = requiredSecrets(parsed);
  const optional = optionalSecrets(parsed, env);
  if (names.length === 0 && optional.length === 0) {
    return { argv: parsed.command, env: { ...env }, secrets: [], project, resolved: null };
  }

  const audit = async (ev) => {
    try { await vault.audit(ev); } catch (_) { /* audit must never unblock or crash a decision */ }
  };
  const deny = async (name, mode, reason, code = 'ZN_POLICY_DENIED') => {
    await audit({ secret: name, mode, agent, tool: 'zn run', argv0: exe, host: null, decision: 'deny', reason });
    throw znError(code, reason);
  };

  const list = await vault.listSecrets();
  const meta = new Map((list || []).map((s) => [s.name, s]));
  const approvals = opts.approvals || approvalStore({ vault, znHome: opts.znHome });
  const resolved = markers.whichSync(argv0, env.PATH || env.Path || '');
  const planted = markers.checkResolvedExecutable(resolved, project);
  const chosen = [];

  for (const name of names) {
    const m = meta.get(name);
    if (!m) {
      await deny(name, null, 'secret ' + name + ' is not in the vault. Add it from your own terminal: zn secret set ' + name, 'ZN_NOT_FOUND');
    }
    if (m.mode !== 'env') {
      await deny(name, m.mode, 'secret ' + name + ' is in ' + (m.mode || 'proxy') + ' mode, so zn run never puts it in a process. ' +
        'For HTTP APIs use the secrets_http_request tool of the zn "secrets" MCP server.');
    }
    const entry = markers.matchAllowCommands(m.allowCommands, parsed.command);
    if (!entry) {
      await deny(name, m.mode, '`' + exe + '` is not in allowCommands for ' + name + '. ' +
        'For HTTP APIs use the secrets_http_request tool of the zn "secrets" MCP server. ' +
        'To allow this command, run in your own terminal: zn secret allow ' + name + ' --command ' + exe);
    }
    if (planted) await deny(name, m.mode, '`' + argv0 + '` ' + planted + '; zn run will not give it ' + name);
    chosen.push({ name, mode: m.mode, command: entry });
  }

  const skipped = [];
  for (const name of optional) {
    const m = meta.get(name);
    const entry = m && m.mode === 'env' && !planted ? markers.matchAllowCommands(m.allowCommands, parsed.command) : null;
    if (entry && await approvals.isApproved(name, entry)) chosen.push({ name, mode: m.mode, command: entry });
    else skipped.push(name);
  }
  if (skipped.length && opts.stderr !== false) {
    (opts.stderr || process.stderr).write('zn run: left as markers in the environment (not allowed or not yet approved for `' + exe + '`): ' + skipped.join(', ') + '\n');
  }

  for (const c of chosen) {
    if (await approvals.isApproved(c.name, c.command)) continue;
    const stdin = opts.stdin || process.stdin;
    const canAsk = !!stdin.isTTY && !tty.agentEnvDetected(env);
    if (!canAsk) {
      await deny(c.name, c.mode, 'first use of ' + c.name + ' with `' + c.command + '` needs your approval. ' +
        'Run once in your own terminal: zn secret approve ' + c.name + ' --command "' + c.command + '"');
    }
    const ask = opts.confirm || ((q) => tty.confirm(q, { stdin, stderr: opts.stderr }));
    const ok = await ask('zn: allow `' + c.command + '` to use secret ' + c.name + ' (the value goes into the process environment)?');
    if (!ok) await deny(c.name, c.mode, 'you declined ' + c.name + ' for `' + c.command + '`');
    await approvals.recordApproval(c.name, c.command);
  }

  const values = new Map();
  for (const c of chosen) {
    const v = await vault.resolve(project, markers.markerFor(c.name));
    if (v == null) await deny(c.name, c.mode, 'secret ' + c.name + ' has no value in the vault', 'ZN_NOT_FOUND');
    values.set(c.name, String(v));
  }

  const childEnv = {};
  for (const [k, v] of Object.entries(env)) childEnv[k] = markers.substitute(v, values);
  for (const name of parsed.secrets) childEnv[name] = values.get(name);
  const argv = parsed.command.map((a) => markers.substitute(a, values));

  for (const c of chosen) {
    await audit({ secret: c.name, mode: c.mode, agent, tool: 'zn run', argv0: exe, host: null, decision: 'allow', reason: 'allowCommands: ' + c.command });
  }
  return { argv, env: childEnv, secrets: chosen.map((c) => ({ ...c, value: values.get(c.name) })), project, resolved };
}

function spawnMasked(prep, opts) {
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const masker = createMasker(prep.secrets);
  let file = prep.argv[0];
  let args = prep.argv.slice(1);
  let shell = false;
  if (process.platform === 'win32' && prep.resolved && /\.(cmd|bat)$/i.test(prep.resolved)) {
    // cmd.exe re-parses its command line: refuse values and metacharacters in arguments.
    const touched = args.some((a, i) => a !== opts.originalArgs[i + 1]);
    if (touched || args.some((a) => /[&|<>^%!"\r\n]/.test(a))) {
      return Promise.reject(znError('ZN_POLICY_DENIED', path.basename(prep.resolved) +
        ' is a batch file: zn run will not pass secret values or shell metacharacters through cmd.exe. ' +
        'Use --secrets NAME to pass the value as an environment variable instead.'));
    }
    file = cmdQuote(prep.resolved);
    args = args.map(cmdQuote);
    shell = true;
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        env: prep.env,
        cwd: opts.cwd || process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe'],
        shell,
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const so = masker.stream();
    const se = masker.stream();
    child.stdout.on('data', (d) => stdout.write(so.write(d)));
    child.stderr.on('data', (d) => stderr.write(se.write(d)));
    const onInt = () => { try { child.kill('SIGINT'); } catch (_) { /* gone */ } };
    const onTerm = () => { try { child.kill('SIGTERM'); } catch (_) { /* gone */ } };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const cleanup = () => {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    };
    child.on('error', (err) => {
      cleanup();
      reject(err.code === 'ENOENT' ? znError('ZN_NOT_FOUND', 'command not found: ' + prep.argv[0]) : err);
    });
    child.on('close', (code, signal) => {
      cleanup();
      stdout.write(so.end());
      stderr.write(se.end());
      resolve(code == null ? (signal === 'SIGINT' ? 130 : 143) : code);
    });
  });
}

/**
 * Programmatic entry. Resolves to the exit code.
 * opts: {vault, env, cwd, stdin, stdout, stderr, confirm, approvals, znHome, agent, project}
 */
async function runBroker(args, opts = {}) {
  const stderr = opts.stderr || process.stderr;
  try {
    const parsed = parseRunArgs(args);
    const env = opts.env || process.env;
    let vault = opts.vault;
    let prep;
    if (requiredSecrets(parsed).length > 0) {
      vault = vault || await loadVault();
      prep = await prepare(parsed, { ...opts, env, vault });
    } else if (optionalSecrets(parsed, env).length > 0) {
      try {
        vault = vault || await loadVault();
        prep = await prepare(parsed, { ...opts, env, vault });
      } catch (err) {
        if (err.code !== 'ZN_LOCKED') throw err;
        stderr.write('zn run: vault locked; environment markers left unresolved\n');
        prep = { argv: parsed.command, env: { ...env }, secrets: [], resolved: null };
      }
    } else {
      prep = { argv: parsed.command, env: { ...env }, secrets: [], resolved: null };
    }
    return await spawnMasked(prep, { ...opts, originalArgs: parsed.command });
  } catch (err) {
    const tag = err.code && String(err.code).startsWith('ZN_') ? '[' + err.code + '] ' : '';
    stderr.write('zn run: ' + tag + err.message + '\n');
    if (err.code === 'ZN_USAGE') return 64;
    if (err.code === 'ZN_POLICY_DENIED') return 77;
    if (err.code === 'ZN_NOT_FOUND') return 127;
    return 1;
  }
}

async function main(args) {
  process.exitCode = await runBroker(args);
}

module.exports = { parseRunArgs, requiredSecrets, optionalSecrets, referencedSecrets, prepare, runBroker, main, USAGE };

// Direct entry (`node lib/broker/run.js -- <command>`), used by hook rewrites.
if (require.main === module) main(process.argv.slice(2));
