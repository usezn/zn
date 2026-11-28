'use strict';

// A write to an instruction file spelled with a brace list or a glob still asks: the shell expands the word, so the
// names it can reach are judged, not the text. A glob that matches no instruction file, or none at all, does not ask.
// The folder is a temporary one with empty files; the commands are only read, never run.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

function setup(t) {
  const home = tempDir(t, 'zn-instr-glob-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  for (const n of ['AGENTS.md', 'CLAUDE.md', 'notes.md', 'notes.txt']) fs.writeFileSync(path.join(proj, n), '');
  return { cwd: proj, home, env: {} };
}

function asks(cmd, o) {
  const note = { hit: null };
  const deny = policy.bashDenial(cmd, Object.assign({ instructionNotice: note }, o));
  assert.equal(deny, null, 'not denied: ' + cmd);
  return !!note.hit;
}

test('brace lists and globs that reach an instruction file ask', (t) => {
  const o = setup(t);
  const cases = [
    'echo x > AGENTS.md',
    'echo x > {AGENTS,foo}.md',
    'echo x > ./{CLAUDE,GEMINI}.md',
    'echo x > AGENTS.{md,txt}',
    'echo x > AGENT?.md',
    'echo x > AGENT[S].md',
    'echo x > CLAUDE.m?',
    'tee {AGENTS,b}.md',
    'cp a AGENTS.m?',
  ];
  for (const c of cases) assert.ok(asks(c, o), c);
});

test('brace lists and globs that reach no instruction file do not ask', (t) => {
  const o = setup(t);
  const cases = [
    'echo x > notes.md',
    'echo x > {a,b}.md',
    'echo x > notes.{md,txt}',
    'echo x > note?.md',
    'echo x > AGENTS.mdx',
    'echo x > .cursorrule*',
    'echo x > [x]GENTS.md',
  ];
  for (const c of cases) assert.equal(asks(c, o), false, c);
});
