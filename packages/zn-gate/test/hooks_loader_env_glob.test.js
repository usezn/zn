'use strict';
const t = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { hookStopOrComputedIn } = require('../lib/loader-env');
const { tempDir } = require('./helpers/tmp');

t('an unquoted glob in a loader assignment written by a shell command is computed, even with a file named LD_DEBUG=help in the project', (tt) => {
  const dir = tempDir(tt, 'zn-ldglob-');
  fs.writeFileSync(path.join(dir, 'LD_DEBUG=help'), '');
  for (const cmd of ['echo LD_DEBUG=he*p > .env', 'echo LD_DEBUG=he?p >> .env', 'echo LD_DEBUG=he[l]p > .env', 'echo LD_DEBUG=he{l,x}p > .env', 'echo LD_TRACE_LOADED_OBJECTS=* > .env']) {
    assert.ok(hookStopOrComputedIn(cmd), cmd);
  }
});

t('a glob left unquoted after a quoted prefix of the name or value is still computed', (tt) => {
  const dir = tempDir(tt, 'zn-ldglob2-');
  fs.writeFileSync(path.join(dir, 'LD_DEBUG=help'), '');
  for (const cmd of ['echo "LD_DEBUG="he*p > .env', "echo 'LD_DEBUG=h'e?p >> .env", 'echo "LD_"DEBUG=he[l]p > .env']) {
    assert.ok(hookStopOrComputedIn(cmd), cmd);
  }
});

t('a quoted glob is not expanded and keeps today\'s verdict; a glob in an unrelated variable passes', () => {
  assert.equal(hookStopOrComputedIn("echo 'LD_DEBUG=he*p' > .env"), null);
  assert.equal(hookStopOrComputedIn('echo "LD_DEBUG=he*p" > .env'), null);
  assert.equal(hookStopOrComputedIn("echo LD_DEBUG='he*p' > .env"), null);
  assert.equal(hookStopOrComputedIn('echo FOO=a*b > .env'), null);
});

t('POSIX quoting: an escaped quote, a closed quote or a comment never hides a later unquoted glob', (tt) => {
  const dir = tempDir(tt, 'zn-ldglob3-');
  fs.writeFileSync(path.join(dir, 'LD_DEBUG=help'), '');
  for (const cmd of [
    'echo \\"x ; echo LD_DEBUG=he*p > .env',
    "echo 'it'\\''s' && echo LD_DEBUG=he?p >> .env",
    "# it's a note\necho LD_DEBUG=he[l]p > .env",
    'echo "a\\"b" ; echo LD_DEBUG=he*p > .env',
    "echo $'a\\'b' ; echo LD_DEBUG=he*p > .env",
    'echo "x ; echo LD_DEBUG=he*p > .env',
    'cat <<EOF > .env\nLD_DEBUG=he*p\nEOF',
  ]) {
    assert.ok(hookStopOrComputedIn(cmd), cmd);
  }
  assert.equal(hookStopOrComputedIn("echo 'LD_DEBUG=he*p' > .env"), null);
  assert.equal(hookStopOrComputedIn('echo "LD_DEBUG=he*p" > .env'), null);
});
