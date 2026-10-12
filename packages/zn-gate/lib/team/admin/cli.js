'use strict';
/**
 * zn team admin login | logout | status
 *
 * Commands for a person at a terminal. `login` reads the org admin token
 * from a hidden prompt or the clipboard (never from the command line),
 * checks it with the zn Team API and stores it in the OS credential store.
 * Agents are refused (TTY check, agent environment variables, and the
 * PreToolUse hook denies these commands).
 */

const config = require('./config');
const { parseOrgToken } = require('./token');
const { createAdminClient } = require('./client');
const tty = require('../../broker/tty');

const USAGE = [
  'Usage:',
  '  zn team admin login [--from-clipboard] [--api-url URL]',
  '                      Store an org admin token created in the zn dashboard (Team > Tokens).',
  '                      The token is read from a hidden prompt or the clipboard, never from arguments.',
  '  zn team admin status  Show which org and token this machine uses (never the token)',
  '  zn team admin logout  Remove the token from this machine (revoke it in the dashboard)',
  '',
].join('\n');

function version() {
  try { return require('../../../package.json').version; } catch (_) { return 'unknown'; }
}

function parseArgs(argv) {
  const out = { fromClipboard: false, apiUrl: null, positional: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-clipboard' || a === '--clipboard') out.fromClipboard = true;
    else if (a === '--api-url' && argv[i + 1]) out.apiUrl = argv[++i];
    else if (a.startsWith('--api-url=')) out.apiUrl = a.slice('--api-url='.length);
    else if (a.startsWith('-')) out.unknown.push(a);
    else out.positional.push(a);
  }
  return out;
}

async function login(argv, io) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const env = io.env || process.env;
  const a = parseArgs(argv);
  if (a.positional.length) {
    // Do not echo it: it may be the token.
    err.write('zn: the org token is never passed as an argument (it would stay in your shell history and the process list).\n' +
      'Run `zn team admin login` and paste it at the hidden prompt, or copy it and use --from-clipboard.\n');
    return 2;
  }
  if (a.unknown.length) {
    err.write('zn: unknown option ' + a.unknown[0] + '\n' + USAGE);
    return 2;
  }
  try {
    tty.requireHuman('zn team admin login', { stdin: io.stdin, env });
  } catch (e) {
    err.write('zn: ' + e.message + '\n');
    return 3;
  }
  let token;
  try {
    token = a.fromClipboard ? (io.readClipboard || tty.readClipboard)() : await (io.readHidden || tty.readHidden)('zn org admin token (input hidden): ', { stdin: io.stdin, stderr: err });
  } catch (e) {
    err.write('zn: ' + (e.code === 'ZN_CANCELLED' ? 'cancelled' : e.message) + '\n');
    return 1;
  }
  token = String(token || '').trim();
  const parsed = parseOrgToken(token);
  if (!parsed) {
    err.write('zn: that is not a zn org admin token (expected znorg_..., checksum failed). Copy it again from the dashboard.\n');
    return 1;
  }
  let apiBase;
  try {
    apiBase = config.apiBase({ env, apiUrl: a.apiUrl });
  } catch (e) {
    err.write('zn: ' + e.message + '\n');
    return 2;
  }
  let who;
  try {
    const client = (io.createClient || createAdminClient)({ token, apiBase, version: version(), clientInfo: { name: 'zn-cli', version: version() } });
    who = await client.whoami();
  } catch (e) {
    err.write('zn: the zn Team API rejected the token or could not be reached: ' + (e.code ? e.code + ': ' : '') + e.message + '\n');
    return 1;
  }
  const p = who.principal || {};
  const info = {
    org_id: who.org && who.org.id,
    org_name: who.org && who.org.name,
    scopes: Array.isArray(p.scopes) ? p.scopes : [],
    expires_at: p.expires_at || null,
    api_base: apiBase,
  };
  let meta;
  try {
    meta = config.saveToken(token, info, { env, home: io.home, keychain: io.keychain });
  } catch (e) {
    err.write('zn: could not store the token: ' + e.message + '\n');
    return 1;
  }
  token = null;
  out.write('Stored the org admin token ' + meta.prefix + ' for ' + (meta.org_name || meta.org_id) + ' (' + meta.org_id + ')\n' +
    '  scopes:  ' + (meta.scopes.join(', ') || '(none)') + '\n' +
    '  expires: ' + (meta.expires_at || 'unknown') + '\n' +
    '  stored:  ' + (meta.store === 'file' ? '~/.zn/team-admin.token (no OS credential store found)' : 'OS credential store (' + meta.store.slice(9) + ')') + '\n' +
    'Restart your agent so `zn-gate mcp` lists the team_* tools.\n');
  return 0;
}

function status(io) {
  const out = io.stdout || process.stdout;
  const env = io.env || process.env;
  const meta = config.readAdminMeta({ env, home: io.home });
  if (meta) {
    out.write('zn Team admin: ' + (meta.org_name || '') + ' (' + meta.org_id + ')\n' +
      '  token:   ' + meta.prefix + ' (' + meta.token_id + ')\n' +
      '  scopes:  ' + ((meta.scopes || []).join(', ') || '(none)') + '\n' +
      '  expires: ' + (meta.expires_at || 'unknown') + '\n' +
      '  stored:  ' + (meta.store === 'file' ? '~/.zn/team-admin.token' : 'OS credential store (' + meta.store.slice(9) + ')') + '\n' +
      '  api:     ' + meta.api_base + '\n');
  } else if (env.ZN_ORG_TOKEN) {
    const parsed = parseOrgToken(String(env.ZN_ORG_TOKEN).trim());
    out.write('zn Team admin: token from ZN_ORG_TOKEN ' + (parsed ? parsed.prefix : '(invalid format)') + '\n');
    for (const w of config.tokenWarnings('env')) out.write('  warning: ' + w + '\n');
  } else {
    out.write('zn Team admin: no org token on this machine. Create one in the zn dashboard (Team > Tokens) and run `zn team admin login`.\n');
  }
  if (env.ZN_LOCAL_ONLY === 'true') out.write('  note: ZN_LOCAL_ONLY=true turns the team_* MCP tools off.\n');
  return 0;
}

function logout(io) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const env = io.env || process.env;
  try {
    tty.requireHuman('zn team admin logout', { stdin: io.stdin, env });
  } catch (e) {
    err.write('zn: ' + e.message + '\n');
    return 3;
  }
  const meta = config.readAdminMeta({ env, home: io.home });
  const removed = config.removeToken({ env, home: io.home, keychain: io.keychain });
  out.write(removed
    ? 'Removed the org admin token' + (meta ? ' ' + meta.prefix : '') + ' from this machine. It still works until it expires or is revoked: revoke it in the zn dashboard (Team > Tokens).\n'
    : 'No org admin token stored on this machine.\n');
  return 0;
}

/** main(argv, io) -> exit code. argv starts after `team admin`. */
async function main(argv, io = {}) {
  const sub = argv[0];
  if (sub === 'login') return login(argv.slice(1), io);
  if (sub === 'logout') return logout(io);
  if (sub === 'status') return status(io);
  (io.stdout || process.stdout).write(USAGE);
  return sub === undefined || sub === '-h' || sub === '--help' || sub === 'help' ? 0 : 2;
}

module.exports = { main, USAGE };
