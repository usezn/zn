'use strict';

// The fd-duplication rewrite (2>&1, >&2, <&-) must give the same segments as the earlier quadratic regex and must
// stay fast on a long run of digits and angle brackets.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { segmentsOf, checkCommand } = require('../lib/destructive');

const OLD_RE = /(\d*[<>]+)&(\d+|-)/g;
const oldNormalise = (cmd) => String(cmd).replace(OLD_RE, '$1_$2');

const CORPUS = [
  'ls 2>&1', 'cmd >&2', 'cmd <&-', 'cmd 3>&-', 'cmd 2>&1 | tee out', 'cmd &> out', 'cmd &>> out', 'cmd |& tee out',
  'a >&1 b >&-', 'a 10>&12', 'a >>&2', 'a <>&3', 'a >&- >&1', 'a & b', 'a && b', 'a &1', 'a & -', 'a>&', 'a 2> &1',
  'a >& file', 'echo "2>&1" && rm -rf /tmp/x', 'a 2>&1; b 1>&2 &', 'a &>&1', 'a <&0 >&2 2>&-', 'a >&1>&2', 'a >&->&1',
  'a 1>&2&& b', '>&1', '&1', '<&-', 'x\n2>&1\ny >&2',
];

test('segmentsOf agrees with the earlier regex on real redirection forms', () => {
  for (const cmd of CORPUS) {
    assert.deepEqual(segmentsOf(cmd), segmentsOf(oldNormalise(cmd)), cmd);
    assert.deepEqual(segmentsOf(cmd, true), segmentsOf(oldNormalise(cmd), true), cmd);
  }
});

test('segmentsOf agrees with the earlier regex on random strings over the redirection alphabet', () => {
  const alphabet = ['<', '>', '&', '-', '1', '2', '0', ' ', '|', ';', 'a', '9'];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let n = 0; n < 3000; n++) {
    let cmd = '';
    const len = rnd() % 24;
    for (let i = 0; i < len; i++) cmd += alphabet[rnd() % alphabet.length];
    assert.deepEqual(segmentsOf(cmd), segmentsOf(oldNormalise(cmd)), JSON.stringify(cmd));
  }
});

test('a 100 KiB command of digits and angle brackets is read in well under a second', () => {
  const size = 100 * 1024;
  const inputs = [
    '1'.repeat(size), '<'.repeat(size), '>'.repeat(size), '1>'.repeat(size / 2), '<>'.repeat(size / 2),
    '1'.repeat(size / 2) + '<'.repeat(size / 2), '1<'.repeat(size / 2 - 1) + '&',
  ];
  for (const cmd of inputs) {
    const t0 = process.hrtime.bigint();
    segmentsOf(cmd);
    checkCommand(cmd);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `${cmd.slice(0, 8)}... took ${ms} ms`);
  }
});
