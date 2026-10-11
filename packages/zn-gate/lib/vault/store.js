'use strict';
/** Encrypted store: named secrets and the per-project token map, in age files under ~/.zn/vault/. */
const { notImplemented } = require('../errors');

function projectKey(project) { throw notImplemented('vault/store.projectKey'); }
async function readEncrypted(file, identity) { throw notImplemented('vault/store.readEncrypted'); }
async function writeEncrypted(file, data, recipient) { throw notImplemented('vault/store.writeEncrypted'); }

module.exports = { projectKey, readEncrypted, writeEncrypted };
