'use strict';
/**
 * IPC client for the vault daemon. The only vault interface other modules use.
 * Every call is async; when the daemon is not running the error code is ZN_LOCKED.
 *
 *   mapToken(project, type, value) -> token          __ZN_<TYPE>_<n>__
 *   resolve(project, token)        -> value|null     broker and detokenize only; never exposed to the agent
 *   setSecret(name, value, meta) / listSecrets() / removeSecret(name)
 *   exactValues(project)           -> [{name, type, values: [raw, b64, hex, url]}]   in memory only
 *   audit(event)                   {secret, mode, agent, tool, argv0, host, decision, reason}
 */
const { notImplemented } = require('../errors');

async function mapToken(project, type, value) { throw notImplemented('vault/client.mapToken'); }
async function resolve(project, token) { throw notImplemented('vault/client.resolve'); }
async function setSecret(name, value, meta) { throw notImplemented('vault/client.setSecret'); }
async function listSecrets() { throw notImplemented('vault/client.listSecrets'); }
async function removeSecret(name) { throw notImplemented('vault/client.removeSecret'); }
async function exactValues(project) { throw notImplemented('vault/client.exactValues'); }
async function audit(event) { throw notImplemented('vault/client.audit'); }

module.exports = { mapToken, resolve, setSecret, listSecrets, removeSecret, exactValues, audit };
