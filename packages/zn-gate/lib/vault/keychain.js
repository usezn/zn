'use strict';
/** age identity in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret) or behind a passphrase. */
const { notImplemented } = require('../errors');

function detectBackend() { throw notImplemented('vault/keychain.detectBackend'); }
async function loadIdentity(opts) { throw notImplemented('vault/keychain.loadIdentity'); }
async function storeIdentity(identity, opts) { throw notImplemented('vault/keychain.storeIdentity'); }

module.exports = { detectBackend, loadIdentity, storeIdentity };
