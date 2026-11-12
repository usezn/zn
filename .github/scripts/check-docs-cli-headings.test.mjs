// Tests of check-docs-cli-headings.mjs. Run: node --test .github/scripts/check-docs-cli-headings.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCommands, listedCommands, sectionCommands } from './check-docs-cli-headings.mjs';

const CLI = [
  '# Ref', '', 'Intro text.', '',
  '## Contents', '',
  '- [`init`](#init)',
  '- [`secret`](#secret)',
  '', '## Program names', '', '- [`not-a-command`](#x)', '',
  '## Set up', '',
  '### `init`', '', 'text', '',
  '### `secret`', '', '#### `secret set`', '',
  '```sh', '### `fake`', '```', '',
  '### Plain heading', '',
].join('\n');

test('the Contents list is read up to the next second-level heading', () => {
  assert.deepEqual(listedCommands(CLI), ['init', 'secret']);
});

test('command sections are code-formatted third-level headings outside fences', () => {
  assert.deepEqual(sectionCommands(CLI), ['init', 'secret']);
});

test('matching lists pass', () => {
  const r = compareCommands(CLI);
  assert.deepEqual(r.problems, []);
});

test('a listed command without a section is named', () => {
  const cli = CLI.replace('- [`secret`](#secret)', '- [`secret`](#secret)\n- [`extra`](#extra)');
  assert.deepEqual(compareCommands(cli, 'docs/cli.md').problems, [
    'docs/cli.md: "extra" is listed in the Contents section but has no "### `extra`" section',
  ]);
});

test('a command section missing from the Contents list is named', () => {
  const cli = CLI.replace('- [`secret`](#secret)\n', '');
  assert.deepEqual(compareCommands(cli, 'docs/cli.md').problems, [
    'docs/cli.md: "### `secret`" has no entry in the Contents section',
  ]);
});

test('a missing Contents section and an empty one fail', () => {
  assert.match(compareCommands('# Ref\n\n### `init`\n').problems[0], /no "## Contents" section/);
  assert.match(compareCommands('## Contents\n\n## Next\n\n### `init`\n').problems[0], /lists no commands/);
});

test('subcommand headings are not command sections', () => {
  assert.deepEqual(sectionCommands('#### `secret set`\n'), []);
});
