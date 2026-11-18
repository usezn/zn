'use strict';

/**
 * What the folder zn keeps its private state in (~/.zn, or ZN_HOME) supports.
 *
 * Some file systems (FAT, exFAT, SMB shares mounted without Unix extensions) accept chmod and ignore it, so evidence,
 * stats, baselines and the vault files stay readable by other users, and they cannot hold a Unix socket, so the
 * vault cannot run there. This probes the folder instead of guessing from the file system name:
 *   - permissions_enforced: a temporary file is made, chmod 0600, and its mode is read back;
 *   - unix_sockets: a Unix socket is bound in the vault's run folder (or the state folder) and closed again.
 * A probe that cannot run (read-only disk, no write access, path too long) never claims a problem: the answer is
 * "supported". Nothing is created when the state folder does not exist yet: the nearest existing parent is probed.
 * The result is cached for the life of the process. Windows uses ACLs and named pipes: nothing to probe there.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

// Codes a Unix-socket bind gives on a file system that cannot hold one (vfat: EPERM, cifs: ENOTSUP).
const NO_SOCKET_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EAFNOSUPPORT']);
// sun_path is about 104 bytes on macOS and 108 on Linux.
const MAX_SOCKET_PATH = 90;

const defaultLayer = {
  isDir: (d) => { try { return fs.statSync(d).isDirectory(); } catch (err) { return false; } },
  create: (file) => fs.closeSync(fs.openSync(file, 'wx', 0o666)),
  chmod: (file, mode) => fs.chmodSync(file, mode),
  modeOf: (file) => fs.statSync(file).mode & 0o777,
  unlink: (file) => fs.unlinkSync(file),
  // Resolves to null when a socket can be bound, else the error code.
  bindSocket: (address) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve((err && err.code) || 'ERROR'));
    server.listen(address, () => server.close(() => resolve(null)));
  }),
};

const cache = new Map();

function nearestExisting(dir, layer) {
  let d = path.resolve(dir);
  for (;;) {
    if (layer.isDir(d)) return d;
    const up = path.dirname(d);
    if (up === d) return d;
    d = up;
  }
}

function probeName(suffix) {
  return '.zn-probe-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + suffix;
}

/** True when a chmod 0600 sticks in the folder; also true when the probe cannot run. */
function probePermissions(dir, layer) {
  const file = path.join(dir, probeName(''));
  let made = false;
  try {
    layer.create(file);
    made = true;
    layer.chmod(file, 0o600);
    return (layer.modeOf(file) & 0o077) === 0;
  } catch (err) {
    return true;
  } finally {
    if (made) { try { layer.unlink(file); } catch (err) { /* nothing more to do */ } }
  }
}

/** True when a Unix socket can be bound in the folder; also true when the probe cannot run. */
async function probeSockets(dir, layer) {
  const address = path.join(dir, probeName('.sock'));
  if (address.length > MAX_SOCKET_PATH) return true;
  let code;
  try { code = await layer.bindSocket(address); } catch (err) { code = err && err.code; }
  try { layer.unlink(address); } catch (err) { /* the socket file is already gone */ }
  return !(code && NO_SOCKET_CODES.has(code));
}

function knownProbeFolder(folder, layer) {
  const base = nearestExisting(folder, layer);
  const run = path.join(folder, 'run');
  return { base, runBase: layer.isDir(run) ? run : base };
}

/**
 * Synchronous half: {folder, permissions_enforced}. `layer` is for tests (chmod, stat and socket results are injected);
 * a given layer is never cached.
 */
function permissionsEnforced(folder, opts = {}) {
  const dir = path.resolve(folder);
  if (process.platform === 'win32' && !opts.layer) return true;
  const layer = opts.layer ? { ...defaultLayer, ...opts.layer } : defaultLayer;
  const hit = !opts.layer && cache.get(dir);
  if (hit && hit.permissions_enforced !== undefined) return hit.permissions_enforced;
  const value = probePermissions(knownProbeFolder(dir, layer).base, layer);
  if (!opts.layer) cache.set(dir, { ...(hit || {}), permissions_enforced: value });
  return value;
}

/** {folder, permissions_enforced, unix_sockets} for the state folder (default: ZN_HOME or ~/.zn). */
async function support(opts = {}) {
  const folder = path.resolve(opts.folder || require('./stats').znHome());
  if (process.platform === 'win32' && !opts.layer) return { folder, permissions_enforced: true, unix_sockets: true };
  const layer = opts.layer ? { ...defaultLayer, ...opts.layer } : defaultLayer;
  const hit = !opts.layer && cache.get(folder);
  if (hit && hit.unix_sockets !== undefined && hit.permissions_enforced !== undefined) return { folder, ...hit };
  const { base, runBase } = knownProbeFolder(folder, layer);
  const result = {
    permissions_enforced: opts.layer ? probePermissions(base, layer) : permissionsEnforced(folder),
    unix_sockets: await probeSockets(runBase, layer),
  };
  if (!opts.layer) cache.set(folder, result);
  return { folder, ...result };
}

const FIX = 'Next step: set ZN_HOME to a folder on a disk with Unix permissions, such as your home disk.';

/** One sentence naming the folder and what it lacks; '' when it supports both. */
function problemText(info) {
  const noPerm = info.permissions_enforced === false;
  const noSock = info.unix_sockets === false;
  if (!noPerm && !noSock) return '';
  const where = 'The folder where zn keeps its private state (' + info.folder + ') ';
  if (noPerm && noSock) return where + 'ignores Unix file permissions and cannot hold Unix sockets (it is probably a FAT, exFAT or network disk), so the evidence log, stats and vault files stay readable by other users and the vault cannot run there. ' + FIX;
  if (noPerm) return where + 'ignores Unix file permissions (it is probably a FAT, exFAT or network disk), so the evidence log, stats and vault files stay readable by other users. ' + FIX;
  return where + 'cannot hold Unix sockets (it is probably a FAT, exFAT or network disk), so the vault cannot run there. ' + FIX;
}

/** Tests only: forget what was probed. */
function _clearCache() { cache.clear(); }

module.exports = { support, permissionsEnforced, problemText, NO_SOCKET_CODES, _clearCache };
