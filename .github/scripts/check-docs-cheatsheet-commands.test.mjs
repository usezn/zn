// Tests of check-docs-cheatsheet-commands.mjs. Run: node --test .github/scripts/check-docs-cheatsheet-commands.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { cellCommand, checkCommands, documentedCommands, namedCommands } from './check-docs-cheatsheet-commands.mjs';

const CLI = [
  '# Command line reference',
  '',
  '## Contents',
  '',
  '- [`init`](#init)',
  '- [`secret`](#secret)',
  '',
  '## Set up',
  '',
  '### `init`',
  '',
  '#### `secret set`',
  '',
  '```sh',
  '### `not-a-heading`',
  '```',
  '',
].join('\n');

test('a cell names a command as code or as a link with code text', () => {
  assert.equal(cellCommand('`init`'), 'init');
  assert.equal(cellCommand('[`secret set`](cli.md#secret-set)'), 'secret set');
  assert.equal(cellCommand('`secret   set`'), 'secret set');
  assert.equal(cellCommand('plain text'), null);
});

test('only the column headed Command is read, whatever its position', () => {
  const md = [
    '| Command | Useful flags | Example |',
    '|---|---|---|',
    '| [`init`](cli.md#init) | `--wrap-mcp` | `zn-gate init` |',
    '',
    '| When you want to | Command |',
    '|---|---|',
    '| Set up | `check` |',
    '',
    '| Useful flags | Command |',
    '|---|---|',
    '| `a\\|b` | `status` |',
  ].join('\n');
  assert.deepEqual(namedCommands(md).map((c) => c.name), ['init', 'check', 'status']);
});

test('an escaped pipe inside a cell does not shift the columns', () => {
  const md = '| Useful flags | Command |\n|---|---|\n| `--format text\\|json` | `scan` |\n';
  assert.deepEqual(namedCommands(md), [{ name: 'scan', line: 3 }]);
});

test('documented commands come from headings and the contents list, not from code blocks', () => {
  const d = documentedCommands(CLI);
  assert.ok(d.has('init'));
  assert.ok(d.has('secret'));
  assert.ok(d.has('secret set'));
  assert.ok(!d.has('not-a-heading'));
});

test('a cheat sheet whose commands are all documented passes', () => {
  const cheat = '| Command | Example |\n|---|---|\n| `init` | `zn-gate init` |\n| [`secret set`](cli.md#secret-set) | `zn-gate secret set X` |\n';
  assert.deepEqual(checkCommands(cheat, CLI), { checked: 2, missing: [] });
});

test('a command missing from cli.md is reported with its line', () => {
  const cheat = '| Command | Example |\n|---|---|\n| `init` | `zn-gate init` |\n| `vault nuke` | `zn-gate vault nuke` |\n';
  assert.deepEqual(checkCommands(cheat, CLI).missing, [{ name: 'vault nuke', line: 4 }]);
});

test('a cheat sheet with no named command fails instead of passing', () => {
  assert.throws(() => checkCommands('# Empty\n\n| Example |\n|---|\n| `zn-gate x` |\n', CLI), /no command/);
});
