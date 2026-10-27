'use strict';
// Structure checks for the JSON fixtures: every .in.json has a matching
// .out.json (and the other way round) in the hook fixture folders, and every
// JSON file under test/fixtures parses. Fixtures are only read here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const PAIRED_DIRS = ['copilot-cli', 'gemini-cli'];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

for (const name of PAIRED_DIRS) {
  test(`${name} fixtures: .in.json and .out.json come in pairs`, () => {
    const dir = path.join(FIXTURES, name);
    const names = new Set(fs.readdirSync(dir));
    const inputs = [...names].filter((n) => n.endsWith('.in.json'));
    const outputs = [...names].filter((n) => n.endsWith('.out.json'));
    assert.ok(inputs.length > 0, `no .in.json files in ${name}`);
    const missingOut = inputs
      .map((n) => n.replace(/\.in\.json$/, '.out.json'))
      .filter((n) => !names.has(n));
    const missingIn = outputs
      .map((n) => n.replace(/\.out\.json$/, '.in.json'))
      .filter((n) => !names.has(n));
    assert.deepStrictEqual(missingOut, [], `inputs without an output in ${name}`);
    assert.deepStrictEqual(missingIn, [], `outputs without an input in ${name}`);
  });
}

test('every JSON file under test/fixtures parses', () => {
  const jsonFiles = walk(FIXTURES).filter((f) => f.endsWith('.json'));
  assert.ok(jsonFiles.length > 0);
  const problems = [];
  for (const file of jsonFiles) {
    const rel = path.relative(FIXTURES, file);
    const text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) {
      problems.push(`${rel}: starts with a byte order mark`);
      continue;
    }
    try {
      JSON.parse(text);
    } catch (err) {
      problems.push(`${rel}: ${err.message}`);
    }
  }
  assert.deepStrictEqual(problems, []);
});
