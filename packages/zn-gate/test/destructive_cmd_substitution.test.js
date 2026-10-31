'use strict';

process.env.ZN_STATS = 'off';

// The text of a $( ) or backtick command substitution is a command Bash runs, even when its output only goes to echo or
// another harmless program and even inside double quotes. checkCommand() reads those bodies as commands. A $(( )) is
// arithmetic, not a command, and text inside single quotes or after a backslash is not expanded. Only the text is
// checked; nothing is run.
// Mirrored by packages/zn-gate-py/tests/test_destructive_cmd_substitution.py.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

test('a destructive command inside a command substitution is blocked', () => {
  for (const c of [
    'echo $(rm -rf ~)',
    'echo "$(rm -rf ~)"',
    'echo "$(rm -rf /)"',
    'echo `rm -rf ~`',
    'echo "`rm -rf ~`"',
    'echo "x $(date) $(rm -rf ~)"',
    'echo "$(echo "$(rm -rf ~)")"',
    'echo "${x:-$(rm -rf ~)}"',
    'echo "$(printf \')\' ; rm -rf ~)"',
    'echo "$(cd /tmp && rm -rf ~)"',
    'printf "%s" "$(sudo rm -rf ~)"',
    'x="$(rm -rf ~)"',
    'echo "$(( $(rm -rf ~) ))"',
    'echo "$(( 1 + $(rm -rf ~) ))"',
    'cat <(rm -rf ~)',
    'diff <(rm -rf ~) /dev/null',
  ]) {
    const res = checkCommand(c);
    assert.equal(res.verdict, 'block', c);
    assert.equal(res.rule, 'destructive:rm_root_home', c);
  }
});

test('a harmless command substitution is allowed', () => {
  for (const c of [
    'echo "$(date +%F)"',
    'echo "today is $(date)"',
    'echo "$(pwd)"',
    'echo "$(echo "hi")"',
    'echo "$(printf \')\')"',
    'echo "$(rm -rf ./build)"',
    'echo `date`',
    'diff <(date) <(pwd)',
    'echo "$(date)" "$(pwd)"',
  ]) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
  }
});

test('text that Bash does not expand is not read as a command', () => {
  for (const c of [
    "echo '$(rm -rf ~)'",
    "echo '$(' ; echo 'rm -rf ~)'",
    "echo \"'$(pwd)'\"",
    'echo "a \\$(rm -rf ~)"',
    'echo "(rm -rf ~)"',
  ]) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
  }
});

test('arithmetic expansion is not a command', () => {
  for (const c of ['echo $((1+2))', 'echo "$((1+2))"', 'echo $(( 1 + 2 ))', 'echo "$(( $(date +%s) - 5 ))"', 'echo "$((rm -rf ~))"']) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
  }
});

test('a substitution whose parenthesis hides in a case pattern, a comment, a here-document or an ANSI-C quote is still read', () => {
  for (const c of [
    'echo "$(case a in a) rm -rf ~ ;; esac)"',
    'echo "$( # )\nrm -rf ~\n)"',
    'echo "$(cat <<E\n)\nE\nrm -rf ~\n)"',
    "echo $'\\'' \"$(rm -rf ~)\" $'\\''",
    'echo "$(echo ${x//)/y}; rm -rf ~)"',
    'echo "$(echo ${x:-)}; rm -rf ~)"',
    'echo "$(echo `echo )` ; rm -rf ~)"',
  ]) {
    const res = checkCommand(c);
    assert.equal(res.verdict, 'block', c);
    assert.equal(res.rule, 'destructive:rm_root_home', c);
  }
});

test('similar substitutions that run nothing destructive stay allowed', () => {
  for (const c of [
    'echo "$(case $x in a) echo hi ;; esac)"',
    'echo "$(date) # not a comment"',
    "echo $'\\'' \"$(date)\" $'\\''",
    'echo "$(cat <<< hi)"',
    'echo "$(echo ${#PATH})"',
    'echo "$(echo ${HOME})"',
    'echo "$(echo `date`)"',
  ]) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
  }
});
