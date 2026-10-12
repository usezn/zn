'use strict';
/**
 * CLI for the vault session:
 *
 *   zn unlock [--ttl 8h] [--idle 30m] [--backend <name>] [--passphrase-stdin] [--foreground]
 *   zn lock
 *   zn vault status
 *   zn vault forget [<project dir>]     (vault must be locked)
 *   zn vault verify                     (audit log: chain, MACs, truncation)
 *   zn vault log [--since 1h]           (audit log: who used which secret; alias: zn secret log)
 *
 * The first `zn unlock` creates the vault: a new age identity stored in the
 * OS keychain, or behind a passphrase when no keychain is available.
 * Passphrases are read from the terminal with echo off, or from stdin with
 * --passphrase-stdin; never from arguments or environment variables.
 *
 * Confirmations (first use of a secret by a command, policy changes) happen
 * outside the agent: with --foreground the daemon stays in this terminal and
 * asks here; otherwise it shows a native dialog, or refuses when the system
 * has none (headless Linux, SSH sessions).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const daemon = require('./daemon');
const keychain = require('./keychain');
const store = require('./store');
const { createClient } = require('./client');
const { agentEnvDetected } = require('../broker/tty');
const { CODES } = require('../errors');

function parseDuration(s, fallback) {
  if (s === undefined) return fallback;
  const m = /^(\d+)(s|m|h)$/.exec(String(s));
  if (!m) throw new Error('invalid duration "' + s + '" (use e.g. 30m, 8h)');
  const n = Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
  if (n < 60000 || n > 24 * 3600000) throw new Error('duration must be between 1m and 24h');
  return n;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) { reject(new Error('no terminal for the passphrase prompt; use --passphrase-stdin')); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer); });
    muted = true;
  });
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function getPassphrase(args, creating) {
  if (args.includes('--passphrase-stdin')) return readStdin();
  const p1 = await promptHidden(creating ? 'New vault passphrase (min ' + keychain.MIN_PASSPHRASE + ' chars): ' : 'Vault passphrase: ');
  if (creating) {
    const p2 = await promptHidden('Repeat passphrase: ');
    if (p1 !== p2) throw new Error('passphrases do not match');
  }
  return p1;
}

function out(s) { process.stdout.write(s + '\n'); }

async function unlockCmd(args) {
  const agent = agentEnvDetected(process.env);
  if (agent) throw new Error('zn unlock must be run by you in your own terminal, not by an AI agent (detected ' + agent + ')');
  const opts = {
    ttlMs: parseDuration(flag(args, '--ttl'), daemon.DEFAULT_TTL_MS),
    idleMs: parseDuration(flag(args, '--idle'), daemon.DEFAULT_IDLE_MS),
  };
  const meta = keychain.readMeta({});
  const backend = flag(args, '--backend') || (meta && meta.backend) || keychain.detectBackend();
  if (!keychain.BACKENDS.includes(backend)) throw new Error('unknown backend ' + backend);
  opts.backend = backend;
  if (backend === 'passphrase') opts.passphrase = await getPassphrase(args, !meta);
  if (args.includes('--foreground')) return unlockForegroundCmd(opts, backend);
  const res = await daemon.unlock(opts);
  if (res.created) out('Created a new vault (' + backend + ') in ' + store.paths().vaultDir);
  out('Vault unlocked until ' + res.expiresAt + ' (locks after ' + Math.round(opts.idleMs / 60000) + ' min idle). Run `zn lock` to lock now.');
  if (res.confirm === 'gui') out('Confirmations (first use of a secret by a command, policy changes) appear as a system dialog.');
  else {
    out('Note: no system dialog is available here, so first-use approvals and policy changes will be refused.');
    out('      To approve them, run the vault in a terminal of its own instead: zn lock && zn unlock --foreground');
  }
  return 0;
}

async function unlockForegroundCmd(opts, backend) {
  if (!process.stdin.isTTY) throw new Error('--foreground needs an interactive terminal (it asks you there)');
  const res = await daemon.unlockForeground(opts);
  if (res.created) out('Created a new vault (' + backend + ') in ' + store.paths().vaultDir);
  out('Vault unlocked until ' + res.expiresAt + ' (locks after ' + Math.round(opts.idleMs / 60000) + ' min idle).');
  out('Keep this terminal open: zn asks here before a secret is used by a command for the first time or a policy changes.');
  out('Press Ctrl+C or run `zn lock` to lock.');
  const onSig = () => { res.close(); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const reason = await res.done;
  out('Vault locked (' + reason + ').');
  return 0;
}

async function lockCmd() {
  const was = await daemon.lock({});
  out(was ? 'Vault locked.' : 'Vault was not unlocked.');
  return 0;
}

async function statusCmd() {
  const meta = keychain.readMeta({});
  if (!meta) { out('Vault: not created yet (run `zn unlock`).'); return 0; }
  const c = createClient({});
  try {
    const s = await c.status();
    out('Vault: unlocked (backend ' + meta.backend + ', expires ' + s.expiresAt + ')');
  } catch (err) {
    out('Vault: locked (backend ' + meta.backend + ')');
  } finally {
    c.close();
  }
  out('Location: ' + store.paths().vaultDir);
  return 0;
}

async function forgetCmd(args) {
  const dir = path.resolve(args[2] || process.cwd());
  const c = createClient({});
  const unlocked = await c.isUnlocked();
  c.close();
  if (unlocked) { process.stderr.write('Lock the vault first (`zn lock`): the daemon may hold this project in memory.\n'); return 1; }
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  out(store.forgetProject(real) ? 'Forgot the token map of ' + real : 'No token map stored for ' + real);
  return 0;
}

async function auditVerifyCmd() {
  const c = createClient({});
  try {
    const r = await c.auditVerify();
    out(r.ok ? 'Audit log OK: ' + r.records + ' records, chain and MACs verified.' : 'Audit log FAILED at record ' + (r.line || r.records) + ': ' + r.error);
    return r.ok ? 0 : 1;
  } finally {
    c.close();
  }
}

/** Returns the process exit code. */
async function runVaultCommand(args) {
  try {
    const [cmd, sub] = args;
    if (cmd === 'unlock') return await unlockCmd(args);
    if (cmd === 'lock') return await lockCmd();
    if (cmd === 'vault' && (sub === 'status' || sub === undefined)) return await statusCmd();
    if (cmd === 'vault' && sub === 'forget') return await forgetCmd(args);
    if (cmd === 'vault' && sub === 'verify') return await auditVerifyCmd();
    if (cmd === 'vault' && sub === 'log') return await require('../broker/cli').dispatch('vault', args.slice(1));
    process.stderr.write('usage: zn unlock | zn lock | zn vault status | zn vault verify | zn vault log [--since 1h] | zn vault forget [dir]\n');
    return 2;
  } catch (err) {
    const hint = err && err.code === CODES.LOCKED ? ' (vault locked: run `zn unlock`)' : '';
    process.stderr.write('[zn] ' + (err && err.message ? err.message : err) + hint + '\n');
    return 1;
  }
}

module.exports = { runVaultCommand, parseDuration };
