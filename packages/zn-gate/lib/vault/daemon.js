'use strict';
/** `zn unlock` / `zn lock` daemon: Unix socket (0600) or Windows named pipe, 8 h / 30 min idle expiry. */
const { notImplemented } = require('../errors');

async function unlock(opts) { throw notImplemented('vault/daemon.unlock'); }
async function lock(opts) { throw notImplemented('vault/daemon.lock'); }

module.exports = { unlock, lock };
