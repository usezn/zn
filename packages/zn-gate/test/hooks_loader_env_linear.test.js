'use strict';
const t = require('node:test');
const assert = require('node:assert/strict');
const { hookStopOrComputedIn } = require('../lib/loader-env');
const { assertLinear } = require('./helpers/time_ratio');

const CAP = 100 * 1024;

// Many quoted expansions before a loader assignment that ends in an unquoted glob: the quote state of the text before the glob must
// be tracked in one pass, or a command under the hook's size cap keeps the hook busy until it times out and the command runs unchecked.
// The value is one long word of quoted segments glued together that ends in an unquoted glob.
const build = (n) => 'echo LD_DEBUG=' + '"$X"'.repeat(n) + '*p > .env';
const FIT = Math.floor((CAP - 40) / 4);

t('an unquoted glob after many quoted segments is refused in linear time', () => {
  assertLinear((cmd) => hookStopOrComputedIn(cmd), build, FIT, 'quoted segments before a glob');
});

t('a near-cap command with an unquoted glob is refused, and fast', () => {
  const cmd = build(FIT);
  assert.ok(cmd.length < CAP);
  const t0 = process.hrtime.bigint();
  const verdict = hookStopOrComputedIn(cmd);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(verdict, 'refused');
  assert.ok(ms < 500, 'took ' + ms.toFixed(0) + ' ms');
});

t('the quote state still decides the glob verdict after a long prefix', () => {
  const pre = 'echo ' + '"$X" '.repeat(1000);
  assert.ok(hookStopOrComputedIn(pre + '"LD_DEBUG="he*p > .env'));
  assert.equal(hookStopOrComputedIn(pre + "'LD_DEBUG=he*p' > .env"), null);
});
