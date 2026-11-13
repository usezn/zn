'use strict';
// docs/cli.md names every agent id that `hooks install <agent>` and
// `hooks uninstall <agent>` accept, so a new adapter fails this test until the
// command reference lists it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { AGENT_IDS, getAdapter } = require('../lib/agents');

const cliDocPath = path.resolve(__dirname, '..', '..', '..', 'docs', 'cli.md');
const present = fs.existsSync(cliDocPath);
const skip = present ? false : 'repository docs not in this checkout';

// The sentence of the `hooks install` section that says which ids `<agent>` can be.
function agentLine() {
  const docs = fs.readFileSync(cliDocPath, 'utf8');
  const lines = docs.split('\n').filter((l) => l.includes('`<agent>` is '));
  assert.strictEqual(lines.length, 1, 'expected one line in docs/cli.md saying which ids `<agent>` can be');
  return lines[0];
}

const backticked = (line) => Array.from(line.matchAll(/`([^`]+)`/g), (m) => m[1]);

test('the agent list of docs/cli.md names every supported agent id', { skip }, () => {
  const names = new Set(backticked(agentLine()));
  const missing = AGENT_IDS.filter((id) => !names.has(id));
  assert.deepStrictEqual(missing, [], 'agent ids missing from docs/cli.md: ' + missing.join(', '));
});

test('every agent name in that list is an id or an alias the program accepts', { skip }, () => {
  const line = agentLine();
  const list = line.slice(line.indexOf('`<agent>` is '), line.indexOf('.', line.indexOf('`<agent>` is ')));
  const names = backticked(list).filter((n) => n !== '<agent>');
  assert.ok(names.length >= AGENT_IDS.length);
  for (const name of names) {
    assert.doesNotThrow(() => getAdapter(name), name + ' is in docs/cli.md but is not an agent zn-gate accepts');
  }
});
