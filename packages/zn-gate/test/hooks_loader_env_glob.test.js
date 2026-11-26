'use strict';
const t = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shellDotenvWrite, OPAQUE_WRITE } = require('../lib/loader-env');
const { tempDir } = require('./helpers/tmp');

const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
const verdict = (cmd) => shellDotenvWrite(cmd, isEnv).verdict;

t('an unquoted glob or brace in a shell write to a .env is refused, even with a file named LD_DEBUG=help in the project', (tt) => {
  const dir = tempDir(tt, 'zn-ldglob-');
  fs.writeFileSync(path.join(dir, 'LD_DEBUG=help'), '');
  for (const cmd of ['echo LD_DEBUG=he*p > .env', 'echo LD_DEBUG=he?p >> .env', 'echo LD_DEBUG=he[l]p > .env', 'echo LD_DEBUG=he{l,x}p > .env',
    'echo LD_TRACE_LOADED_OBJECTS=* > .env', 'echo A* > .env', 'echo {A,B}=1 > .env']) {
    assert.ok(verdict(cmd), cmd);
  }
});

t('a glob left unquoted after a quoted prefix of the name or value is refused', (tt) => {
  const dir = tempDir(tt, 'zn-ldglob2-');
  fs.writeFileSync(path.join(dir, 'LD_DEBUG=help'), '');
  for (const cmd of ['echo "LD_DEBUG="he*p > .env', "echo 'LD_DEBUG=h'e?p >> .env", 'echo "LD_"DEBUG=he[l]p > .env']) {
    assert.ok(verdict(cmd), cmd);
  }
});

t('a quoted glob in a write to a .env is refused too, and the same text written to another file passes', () => {
  // Policy changed (2026-11-25): a quoted glob used to pass as plain text. Every shell write to a .env is refused now.
  assert.ok(verdict("echo 'LD_DEBUG=he*p' > .env"));
  assert.ok(verdict('echo "LD_DEBUG=he*p" > .env'));
  assert.ok(verdict("echo LD_DEBUG='he*p' > .env"));
  assert.equal(verdict("echo 'FOO=a*b' > .env"), OPAQUE_WRITE);
  assert.equal(verdict('echo FOO=a*b > .env'), OPAQUE_WRITE);
  assert.equal(verdict("echo 'LD_DEBUG=he*p' > notes.txt"), null);
});

t('POSIX quoting: an escaped quote, a closed quote or a comment never hides a later write', () => {
  for (const cmd of [
    'echo \\"x ; echo LD_DEBUG=he*p > .env',
    "echo 'it'\\''s' && echo LD_DEBUG=he?p >> .env",
    "# it's a note\necho LD_DEBUG=he[l]p > .env",
    'echo "a\\"b" ; echo LD_DEBUG=he*p > .env',
    "echo $'a\\'b' ; echo LD_DEBUG=he*p > .env",
    'echo "x ; echo LD_DEBUG=he*p > .env',
    'cat <<EOF > .env\nLD_DEBUG=he*p\nEOF',
    // The literal write first, then one zn cannot see: the second one refuses the command.
    "echo A=1 > .env; printf '%b' x > .env",
    "echo A=1 > .env\ncat <<'X' > a.txt\nq\nX\nprintf '%b' y > .env",
    'echo A=1 > .env; x="$(true)"; printf y > .env',
  ]) {
    assert.ok(verdict(cmd), cmd);
  }
  assert.equal(verdict("echo 'LD_DEBUG=he*p' > notes.txt"), null);
});

t('a comment that ends in a backslash before a write to .env is refused as unsupported syntax', () => {
  for (const cmd of [
    '# note \\\necho LD_DEBUG=he*p > .env',
    '# note \\\necho "a ; echo LD_DEBUG=he*p > .env ; echo \\"',
    'true ; # note \\\necho LD_DEBUG=he?p >> .env',
    '# note \\\necho FOO=bar > .env',
  ]) {
    assert.ok(verdict(cmd), cmd);
  }
});

t('a normal comment without a trailing backslash followed by a write to .env is refused; one before another file passes', () => {
  // Policy changed (2026-11-25): these writes to .env used to pass as literal text.
  assert.equal(verdict('# note about the build\necho FOO=bar > .env'), OPAQUE_WRITE);
  assert.equal(verdict('# a back\\slash inside\necho FOO=bar > .env'), OPAQUE_WRITE);
  assert.equal(verdict('echo FOO=1 >> .env # $X'), OPAQUE_WRITE);
  assert.equal(verdict('# note about the build\necho FOO=bar > notes.txt'), null);
});
