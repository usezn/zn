'use strict';

process.env.ZN_STATS = 'off';

// Windows drops trailing dots and spaces from a name, so a write to `AGENTS.md.` (a file that does not exist yet)
// opens AGENTS.md: the instruction-file review has to see it, as classifyPath does for the protected settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

// Posix-style layout with the platform flag set to win32 (the Node test host is not Windows); on a real Windows host
// path.resolve adds a drive, so the same layout is written with one.
const REAL_WIN = process.platform === 'win32';
const L = (p) => (REAL_WIN ? 'C:' + p.split('/').join(String.fromCharCode(92)) : p);
const O = { cwd: L('/Users/alice/proj'), home: L('/Users/alice'), env: {} };

const INSTRUCTION = [
  'AGENTS.md.',
  'AGENTS.md ',
  'AGENTS.md. .',
  'CLAUDE.md..',
  'claude.md.',
  '.cursorrules.',
  '.windsurfrules ',
  'GEMINI.md.',
  'sub/dir/AGENTS.md.',
  'sub./dir /CLAUDE.md',
  '/Users/alice/proj/AGENTS.md.',
  '/Users/alice/proj/.cursor/rules/team.mdc.',
  '/Users/alice/proj/.github/copilot-instructions.md.',
];
const BENIGN = ['notes.md', 'notes.md.', 'notes.md ', 'sub/dir/readme.md.', 'AGENTS.md.bak', 'AGENTS.mdx.'];

test('trailing dots and spaces name the instruction file (write and edit, win32)', () => {
  asWindows(() => {
    const missed = INSTRUCTION.filter((p) => !policy.instructionWriteNotice(p, O));
    assert.deepEqual(missed, []);
    assert.deepEqual(INSTRUCTION.filter((p) => !policy.instructionWriteNotice(p.replace(/ $/, ''), O)), []);
  });
});

test('a shell redirect to a trailing-dot instruction file is noticed (win32)', () => {
  asWindows(() => {
    const missed = [];
    for (const p of INSTRUCTION) {
      const forms = [p.includes(' ') ? null : 'echo x>' + p, 'echo x>"' + p + '"', 'echo x > "' + p + '"', 'echo x >> "' + p + '"'];
      for (const cmd of forms.filter(Boolean)) {
        const note = {};
        policy.bashDenial(cmd, { ...O, instructionNotice: note });
        if (!note.hit) missed.push(cmd);
      }
    }
    assert.deepEqual(missed, []);
  });
});

test('other names are not instruction files (win32 control)', () => {
  asWindows(() => {
    const flagged = BENIGN.filter((p) => policy.instructionWriteNotice(p, O));
    assert.deepEqual(flagged, []);
    const note = {};
    policy.bashDenial('echo x>"notes.md."', { ...O, instructionNotice: note });
    assert.ok(!note.hit);
  });
});

test('on posix a trailing dot is a different name', () => {
  if (REAL_WIN) return;
  assert.equal(policy.instructionWriteNotice('AGENTS.md.', O), null);
  assert.ok(policy.instructionWriteNotice('AGENTS.md', O));
});
