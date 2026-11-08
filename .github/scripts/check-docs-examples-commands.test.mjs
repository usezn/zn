// Tests of check-docs-examples-commands.mjs. Run: node --test .github/scripts/check-docs-examples-commands.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExamples, commandsInLine, documentedCommands, fencedBlocks } from './check-docs-examples-commands.mjs';

const CLI = '# Ref\n\n## Group\n\n### `init`\n\ntext\n\n### `secret`\n\n#### `secret set`\n\n```sh\n### `fake`\n```\n\n### Plain heading\n';

test('documented commands are the first words of code headings outside fences', () => {
  assert.deepEqual([...documentedCommands(CLI)].sort(), ['init', 'secret']);
});

test('fenced blocks carry the language and line numbers', () => {
  const b = fencedBlocks('a\n```sh\nzn init\n```\n~~~text\nx\n~~~\n');
  assert.equal(b.length, 2);
  assert.equal(b[0].lang, 'sh');
  assert.deepEqual(b[0].lines, [{ n: 3, text: 'zn init' }]);
});

test('commands in a line: programs, npx, prompts, chains, comments', () => {
  assert.deepEqual(commandsInLine('$ zn-gate init --yes'), [{ program: 'zn-gate', sub: 'init' }]);
  assert.deepEqual(commandsInLine('npx -y zn-gate@latest check'), [{ program: 'zn-gate', sub: 'check' }]);
  assert.deepEqual(commandsInLine('zn --json status | jq . && zn-gate why 1'), [
    { program: 'zn', sub: 'status' },
    { program: 'zn-gate', sub: 'why' },
  ]);
  assert.deepEqual(commandsInLine('FOO=1 zn run -- ls # zn nope'), [{ program: 'zn', sub: 'run' }]);
  assert.deepEqual(commandsInLine('zn-gate'), [{ program: 'zn-gate', sub: null }]);
});

test('install lines and other programs are not commands', () => {
  assert.deepEqual(commandsInLine('npm install -g zn-gate'), []);
  assert.deepEqual(commandsInLine('pip install zn-gate'), []);
  assert.deepEqual(commandsInLine('cat ~/.zn/config'), []);
});

test('an undocumented subcommand in a shell block is reported with its line', () => {
  const md = '# Ex\n\n```sh\nzn init\nnpx -y zn-gate bogus --x\n```\n';
  const r = checkExamples(CLI, [{ name: 'docs/examples/a.md', text: md }]);
  assert.equal(r.commands, 2);
  assert.deepEqual(r.problems, [{ file: 'docs/examples/a.md', line: 5, command: 'zn-gate bogus' }]);
});

test('documented commands, other languages and continuation lines pass', () => {
  const md = '```sh\nzn secret set A \\\n  bogus\n```\n```json\nzn bogus\n```\n```text\nzn bogus\n```\n';
  const r = checkExamples(CLI, [{ name: 'a.md', text: md }]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.commands, 1);
});
