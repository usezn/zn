'use strict';
/**
 * zn Team org admin tokens.
 *
 *   znorg_<tid:12 base62>_<secret:43 base62><crc:6 base62>
 *
 * crc is the CRC-32 (IEEE, as in zlib) of `znorg_<tid>_<secret>`, written in
 * base62 (0-9, A-Z, a-z) and left-padded with "0" to 6 characters. It lets
 * the scrubber and secret scanners recognise a token offline and catches
 * typos before a request is made. The public id is `tok_<tid>`; the visible
 * prefix is `znorg_<tid>` (not secret).
 */

const TOKEN_RE = /^znorg_([A-Za-z0-9]{12})_([A-Za-z0-9]{43})([A-Za-z0-9]{6})$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c;
  }
  return TABLE;
}

/** CRC-32 (IEEE 802.3) of a string's UTF-8 bytes, as an unsigned integer. */
function crc32(text) {
  const t = crcTable();
  const buf = Buffer.from(String(text), 'utf8');
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function base62(n, width) {
  let s = '';
  let v = n;
  do {
    s = BASE62[v % 62] + s;
    v = Math.floor(v / 62);
  } while (v > 0);
  return s.padStart(width, '0');
}

/** The 6-character checksum of `znorg_<tid>_<secret>`. */
function orgTokenCrc(body) {
  return base62(crc32(body), 6);
}

/** True when the string has the token shape and a matching checksum. */
function orgTokenCrcOk(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return false;
  return orgTokenCrc('znorg_' + m[1] + '_' + m[2]) === m[3];
}

/**
 * parseOrgToken(token) -> {tid, tokenId, prefix} or null (bad shape or bad
 * checksum). The secret part is never returned.
 */
function parseOrgToken(token) {
  if (!orgTokenCrcOk(token)) return null;
  const tid = TOKEN_RE.exec(token)[1];
  return { tid, tokenId: 'tok_' + tid, prefix: 'znorg_' + tid };
}

/** Visible prefix of a token-shaped string, or null. */
function prefixOf(token) {
  const m = /^znorg_([A-Za-z0-9]{12})_/.exec(String(token || ''));
  return m ? 'znorg_' + m[1] : null;
}

/** Build a token from its parts (tests and the mock API). */
function makeOrgToken(tid, secret) {
  const body = 'znorg_' + tid + '_' + secret;
  return body + orgTokenCrc(body);
}

/** Replace anything token-shaped in a string by its visible prefix. */
const ANY_TOKEN_RE = /znorg_([A-Za-z0-9]{12})_[A-Za-z0-9]{20,}/g;
function maskTokens(text) {
  return String(text).replace(ANY_TOKEN_RE, (_, tid) => 'znorg_' + tid + '_[REDACTED]');
}

module.exports = {
  TOKEN_RE,
  crc32,
  orgTokenCrc,
  orgTokenCrcOk,
  parseOrgToken,
  prefixOf,
  makeOrgToken,
  maskTokens,
};
