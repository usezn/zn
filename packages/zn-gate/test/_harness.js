'use strict';
/* Minimal async test harness shared by the scrubber and vault tests. */

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run(title) {
  console.log(title);
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok   ' + t.name);
    } catch (err) {
      failed++;
      const stack = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : String(err);
      console.log('  FAIL ' + t.name + '\n       ' + stack);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
  return failed;
}

module.exports = { test, run };
