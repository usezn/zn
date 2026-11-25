'use strict';
const t = require('node:test');
const assert = require('node:assert/strict');
const { shellDotenvWrite } = require('../lib/loader-env');
const { assertLinear } = require('./helpers/time_ratio');

const CAP = 100 * 1024;
const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
const verdict = (cmd) => shellDotenvWrite(cmd, isEnv).verdict;

// Many quoted expansions before a loader assignment that ends in an unquoted glob: the command must be read in one pass, or a command
// under the hook's size cap keeps the hook busy until it times out and the command runs unchecked.
const build = (n) => 'echo LD_DEBUG=' + '"$X"'.repeat(n) + '*p > .env';
const FIT = Math.floor((CAP - 40) / 4);

t('an unquoted glob after many quoted segments is refused in linear time', () => {
  assertLinear((cmd) => verdict(cmd), build, FIT, 'quoted segments before a glob');
});

t('a near-cap command with an unquoted glob is refused, and fast', () => {
  const cmd = build(FIT);
  assert.ok(cmd.length < CAP);
  const t0 = process.hrtime.bigint();
  const v = verdict(cmd);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(v, 'refused');
  assert.ok(ms < 500, 'took ' + ms.toFixed(0) + ' ms');
});

t('the quote state still decides the verdict after a long literal prefix', () => {
  const pre = "echo 'X=1' > notes.txt; ".repeat(1000);
  assert.ok(verdict(pre + 'echo "LD_DEBUG="he*p > .env'));
  assert.equal(verdict(pre + "echo 'LD_DEBUG=he*p' > .env"), null);
});

t('many simple commands and here-document lines are read in linear time', () => {
  assertLinear((cmd) => verdict(cmd), (n) => 'echo A=1 > .env; '.repeat(n), 5000, 'many literal writes');
  assertLinear((cmd) => verdict(cmd), (n) => "cat <<'EOF' > .env\n" + 'A=1\n'.repeat(n) + 'EOF\n', 20000, 'a long here-document');
});
