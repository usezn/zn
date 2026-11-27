'use strict';

// Variables, defaults, globs, braces and substitutions in a protected name, and the time the library takes on hostile input.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/rules');

const blocked = (text) => rules.evaluate(text).rule === 'path:sensitive_file';

test('assignments, defaults and unknown variables are resolved against the protected names', () => {
  for (const t of ['F=.env; cat ${F}', 'F=.env; cat "$F"', 'D=~/.ssh; cat $D/id_ed25519', 'cat ${UNSET:-.env}', 'cat .e${E}nv',
    'A=.e; B=${A}nv; cat $B', 'cat ~/.ssh/$KEY', 'export F=.env; . $F']) {
    assert.ok(blocked(t), t);
  }
  for (const t of ['F=notes.txt; cat $F', 'cat ${HOME}/notes.txt', 'echo ${PATH}', 'cat $FILE', 'cat $PROJECT/id_rsa']) {
    assert.ok(!blocked(t), t);
  }
});

test('globs and braces reach a protected name only through its dot and its other parts', () => {
  for (const t of ['cat ~/.s*/id_ed25519', 'cat .en{v,}', 'cat .en[v]', 'cat .*', "find . -name '.e*' -exec cat {} +", 'cat ~/.aws/cred*']) {
    assert.ok(blocked(t), t);
  }
  for (const t of ['cat *', 'cat *.md', 'cat ~/.ssh/*.pub', 'cat .e*.example', "find . -name '*.js'", "grep '.e*' notes.txt", 'cat README{,.bak}']) {
    assert.ok(!blocked(t), t);
  }
});

test('substitutions with literal arguments and ANSI-C escapes are replaced by their output', () => {
  for (const t of ['cat ~/.ssh/$(printf %s id_ed25519)', 'cat .e$(printf nv)', "cat $'\\x2eenv'", "cat $'\\056env'", 'cat .e`echo nv`']) {
    assert.ok(blocked(t), t);
  }
  assert.ok(!blocked('echo $(printf hello)'));
});

test('hostile input stays fast', () => {
  const texts = [
    'cat ' + '*'.repeat(400) + 'x',
    'cat .' + '*a'.repeat(200),
    'cat ' + '{a,b}'.repeat(60),
    'cat ' + '{'.repeat(400),
    'cat ' + '[a'.repeat(300),
    '$(printf '.repeat(5000),
    'a=b; '.repeat(20000) + 'cat $a',
    'X=' + '$X'.repeat(100) + '; cat $X',
    "$'" + '\\x41'.repeat(300) + "'",
    '${A:-'.repeat(3000),
    'cat .e* '.repeat(20000),
    '$' + 'a'.repeat(100000),
  ];
  for (const t of texts) {
    const t0 = process.hrtime.bigint();
    rules.evaluate(t);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 3000, `${t.slice(0, 20)}: ${ms} ms`);
  }
});
