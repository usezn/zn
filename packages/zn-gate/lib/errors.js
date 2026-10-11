'use strict';
/**
 * Error codes shared by the scrubber, the vault and the broker.
 *
 *   ZN_LOCKED            the vault daemon is not running (run `zn unlock`)
 *   ZN_POLICY_DENIED     the request was refused by policy
 *   ZN_NOT_FOUND         the secret or token does not exist
 *   ZN_NOT_IMPLEMENTED   placeholder for a module that is not built yet
 */

const CODES = Object.freeze({
  LOCKED: 'ZN_LOCKED',
  POLICY_DENIED: 'ZN_POLICY_DENIED',
  NOT_FOUND: 'ZN_NOT_FOUND',
  NOT_IMPLEMENTED: 'ZN_NOT_IMPLEMENTED',
});

function znError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function notImplemented(what) {
  const err = znError(CODES.NOT_IMPLEMENTED, what + ' is not implemented yet');
  err.znNotImplemented = true;
  return err;
}

module.exports = { CODES, znError, notImplemented };
