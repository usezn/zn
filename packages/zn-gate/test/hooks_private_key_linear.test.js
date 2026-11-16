'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPrivateKey } = require('../lib/hooks/runner');

// The body check as it was before the fix, kept here to prove both agree on real key shapes.
const OLD_BODY = /^\s*(?:[ \t]*[A-Za-z0-9+\/=]{8,}[ \t]*\r?\n){2}|^\s*[A-Za-z0-9+\/=]{64,}/;
const HEADER = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/g;
function oldHas(text) {
  if (/PuTTY-User-Key-File-/.test(text)) return true;
  HEADER.lastIndex = 0;
  let m;
  while ((m = HEADER.exec(text)) !== null) {
    if (OLD_BODY.test(text.slice(m.index + m[0].length, m.index + m[0].length + 4096))) return true;
  }
  return false;
}

const b64 = (n) => 'Zm9vYmFy'.repeat(Math.ceil(n / 8)).slice(0, n);
const hdr = (kind) => '-----BEGIN ' + kind + 'PRIVATE KEY-----';
const hdrBlock = '-----BEGIN PGP PRIVATE KEY BLOCK-----';

const CASES = [
  ['rsa', hdr('RSA ') + '\n' + b64(64) + '\n' + b64(64) + '\n-----END RSA PRIVATE KEY-----\n'],
  ['ec', hdr('EC ') + '\n' + b64(64) + '\n' + b64(30) + '\n'],
  ['openssh', hdr('OPENSSH ') + '\n' + b64(70) + '\n' + b64(70) + '\n'],
  ['encrypted', hdr('ENCRYPTED ') + '\n' + b64(64) + '\n' + b64(64) + '\n'],
  ['plain pkcs8', hdr('') + '\n' + b64(64) + '\n' + b64(64) + '\n'],
  ['legacy rsa with Proc-Type headers', hdr('RSA ') + '\nProc-Type: 4,ENCRYPTED\n\n' + b64(64) + '\n' + b64(64) + '\n'], // not detected before either
  ['pgp', hdrBlock + '\n\n' + b64(64) + '\n' + b64(64) + '\n'],
  ['crlf', hdr('RSA ') + '\r\n' + b64(64) + '\r\n' + b64(64) + '\r\n'],
  ['yaml indented', 'key: |\n  ' + hdr('RSA ') + '\n  ' + b64(64) + '\n  ' + b64(64) + '\n'],
  ['indented body lines', hdr('') + '\n    ' + b64(20) + '\n    ' + b64(20) + '\n'],
  ['tab indented', hdr('') + '\n\t' + b64(20) + ' \t\n\t' + b64(20) + '\n'],
  ['blank lines first', hdr('') + '\n\n  \n' + b64(20) + '\n' + b64(20) + '\n'],
  ['json escaped', '{"k":"' + hdr('RSA ') + '\\n' + b64(80) + '\\n' + b64(80) + '\\n"}'],
  ['json escaped short', '{"k":"' + hdr('RSA ') + '\\n' + b64(20) + '\\n' + b64(20) + '\\n"}'],
  ['one long line', hdr('') + ' ' + b64(64)],
  ['one short line', hdr('') + '\n' + b64(20) + '\n'],
  ['two short lines', hdr('') + '\n' + b64(7) + '\n' + b64(7) + '\n'],
  ['only header', 'Never paste ' + hdr('') + ' into a prompt.'],
  ['header only at end', hdr('')],
  ['second line unterminated', hdr('') + '\n' + b64(20) + '\n' + b64(20)],
  ['fake then real', hdr('') + ' mention\n' + hdr('RSA ') + '\n' + b64(64) + '\n' + b64(64) + '\n'],
  ['putty', 'PuTTY-User-Key-File-3: ssh-ed25519\n'],
  ['no key', 'plain prompt text\nwith lines\n'],
  ['header then spaces then body', hdr('') + ' '.repeat(2000) + '\n' + b64(20) + '\n' + b64(20) + '\n'],
];

test('private key detection agrees with the previous regex on key shapes', () => {
  for (const [name, text] of CASES) assert.equal(hasPrivateKey(text), oldHas(text), name);
  const want = new Set(['rsa', 'ec', 'openssh', 'encrypted', 'plain pkcs8', 'pgp', 'crlf', 'yaml indented', 'indented body lines',
    'tab indented', 'blank lines first', 'one long line', 'fake then real', 'putty', 'header then spaces then body']);
  for (const [name, text] of CASES) assert.equal(hasPrivateKey(text), want.has(name), name);
});

test('private key detection agrees with the previous regex on generated shapes', () => {
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const ws = [' ', '\t', '\n', '\r\n', '  '];
  const bodies = [b64(7), b64(8), b64(20), b64(63), b64(64), 'ab$d'.repeat(5), ''];
  for (let i = 0; i < 400; i++) {
    let t = rnd(2) ? 'x ' : '';
    t += hdr(['', 'RSA ', 'EC '][rnd(3)]);
    for (let k = 0; k < 1 + rnd(4); k++) t += ws[rnd(ws.length)] + bodies[rnd(bodies.length)];
    t += ws[rnd(ws.length)];
    assert.equal(hasPrivateKey(t), oldHas(t), JSON.stringify(t));
  }
});

test('private key detection stays fast on header plus spaces (100 KB and 1 MB)', () => {
  const unit = hdr('') + ' '.repeat(4096);
  const t0 = process.hrtime.bigint();
  assert.equal(hasPrivateKey(unit.repeat(Math.ceil(100000 / unit.length))), false);
  const ms100 = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms100 < 300, '100 KB took ' + ms100 + ' ms');
  const t1 = process.hrtime.bigint();
  hasPrivateKey(unit.repeat(Math.ceil(1000000 / unit.length)));
  const ms1m = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(ms1m < 1000, '1 MB took ' + ms1m + ' ms');
  assert.equal(hasPrivateKey(hdr('') .repeat(300)), true); // more headers than the cap
  const sp = hdr('') + ' '.repeat(1000000);
  const t2 = process.hrtime.bigint();
  assert.equal(hasPrivateKey(sp), false);
  assert.ok(Number(process.hrtime.bigint() - t2) / 1e6 < 300);
});
