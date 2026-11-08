'use strict';

// What a person reads when zn stops a command with a wildcard: it names the pattern and what to do, and does not say that `*` "holds secrets".

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

// A project folder with a .env file, inside a home folder of its own.
function project(t) {
  const home = tempDir(t, 'zn-glob-msg-home-');
  const dir = path.join(home, 'work', 'app');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=1\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return { home, dir };
}

test('a wildcard that would also match a .env file says so and says what to do', (t) => {
  const { home, dir } = project(t);
  for (const cmd of ['ls *', 'cat *', 'cat .e*']) {
    const msg = policy.bashDenial(cmd, { cwd: dir, home });
    assert.ok(msg, cmd);
    assert.match(msg, /^zn: the pattern \S+ was not read because it would also match a \.env file, which holds secrets, and secret values never go to the AI model\./, cmd);
    assert.match(msg, /Name the files you need instead \(for example `cat notes\.md` instead of `cat \*`\), or ask the user to run the command in their own terminal\.$/, cmd);
    assert.doesNotMatch(msg, /treats it as holding secrets/, 'a wildcard is not a file that holds secrets: ' + cmd);
    assert.doesNotMatch(msg, /environment variable/, cmd);
  }
});

test('a wildcard in the home folder that would match a credentials file names that kind, as a pattern', (t) => {
  const home = tempDir(t, 'zn-glob-msg-home2-');
  fs.writeFileSync(path.join(home, 'notes.txt'), 'x\n');
  const msg = policy.bashDenial('ls *', { cwd: home, home });
  assert.ok(msg);
  assert.match(msg, /^zn: the pattern \* was not read because it would also match a file that holds secrets \(\.netrc credentials\), and secret values never go to the AI model\./);
  assert.doesNotMatch(msg, /treats it as holding secrets/);
});

test('a pattern too broad to check says that, in the same words', (t) => {
  const { home, dir } = project(t);
  const msg = policy.bashDenial('cat ' + '[ab]'.repeat(1100), { cwd: dir, home });
  assert.ok(msg);
  assert.match(msg, /was not read because it is too broad for zn to check that it matches no file that holds secrets, and secret values never go to the AI model\./);
  assert.doesNotMatch(msg, /treats it as holding secrets/);
});

test('the message for a named secret file keeps its words, and a wildcard that leaves the .env file out still goes', (t) => {
  const { home, dir } = project(t);
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'x\n');
  const msg = policy.bashDenial('cat ~/.ssh/id_rsa', { cwd: dir, home });
  assert.match(msg || '', /was not read because zn treats it as holding secrets \(SSH private key\), and secret values never go to the model\./);
  assert.equal(policy.bashDenial('cat *.md', { cwd: dir, home }), null);
});

test('the troubleshooting page has a section for this message', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'troubleshooting.md'), 'utf8');
  assert.ok(doc.includes('#### "zn: the pattern `<pattern>` was not read because it would also match a .env file"'));
});
