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

// A new file written under its 8.3 short name cannot be resolved (it does not exist yet): the name's start is checked.
test('8.3 short names of a new instruction file are reviewed (win32)', () => {
  asWindows(() => {
    const names = ['AGENTS~1.MD', 'agents~1.md', 'CLAUDE~1.MD', 'GEMINI~1.MD', 'COPILO~1.MD', 'CURSOR~1', 'WINDSU~1', 'CLAUDE~2.MD',
      'sub/dir/AGENTS~1.MD', '/Users/alice/proj/.github/COP3F1~1.MD', '/Users/alice/proj/.cursor/rules/AB12CD~1.MDC'];
    assert.deepEqual(names.filter((p) => !policy.instructionWriteNotice(p, O)), []);
    const note = {};
    policy.bashDenial('echo x>AGENTS~1.MD', { ...O, instructionNotice: note });
    assert.ok(note.hit);
  });
});

test('other short names stay allowed (win32 control)', () => {
  asWindows(() => {
    const benign = ['NOTES~1.MD', 'ABCDEF~1.TXT', 'AGENTS~1.TXT', 'AGENTS~1.MDX', 'proj~1/NOTES~1.MD', '/Users/alice/proj/docs/COP3F1~1.MD',
      '/Users/alice/proj/.github/COP3F1~1.TXT'];
    assert.deepEqual(benign.filter((p) => policy.instructionWriteNotice(p, O)), []);
  });
});

test('on posix a tilde name is just a name', () => {
  if (REAL_WIN) return;
  assert.equal(policy.instructionWriteNotice('AGENTS~1.MD', O), null);
});

// An 8.3 short name in a folder of the path (not only the last name) stands for the long folder: CURSOR~1 is .cursor.
test('8.3 short folder names of an instruction folder are reviewed (win32)', () => {
  asWindows(() => {
    const names = ['CURSOR~1/rules/x.mdc', 'CURSOR~1\\rules\\x.mdc', 'GITHUB~1/COPILO~1.MD', 'GITHUB~1\\COPILO~1.MD',
      'GITHUB~1/copilot-instructions.md', 'sub/CURSOR~1/rules/deep/x.mdc', '/Users/alice/proj/CURSOR~1/rules/x.mdc'];
    assert.deepEqual(names.filter((p) => !policy.instructionWriteNotice(p, O)), []);
    const note = {};
    policy.bashDenial('echo x>CURSOR~1/rules/x.mdc', { ...O, instructionNotice: note });
    assert.ok(note.hit);
  });
});

test('short folders that are not instruction folders stay allowed (win32 control)', () => {
  asWindows(() => {
    const benign = ['NOTES~1.MD', 'PROJEC~1/notes.md', 'docs/x.md', 'DOCUME~1/x.md', 'CURSOR~1/x.md', 'GITHUB~1/workflows/ci.yml',
      'CLAUDE~1/commands/x.md', 'NOTES~1/rules/x.mdc'];
    assert.deepEqual(benign.filter((p) => policy.instructionWriteNotice(p, O)), []);
  });
});

test('win32: many short folders after .cursor/rules still ask, and a long path stays fast', () => {
  asWindows(() => {
    const deep = 'CURSOR~1/rules/' + 'CLAUDE~1/'.repeat(7) + 'x.mdc';
    assert.ok(policy.instructionWriteNotice(deep, O), deep);
    assert.ok(policy.instructionWriteNotice('CURSOR~1/rules/' + 'CLAUDE~1/'.repeat(6) + 'x.mdc', O));
    const long = 'CURSOR~1/rules/' + 'CLAUDE~1/'.repeat(4000) + 'x.mdc';
    const plain = 'docs/' + 'notes/'.repeat(4000) + 'x.md';
    const t0 = process.hrtime.bigint();
    policy.instructionWriteNotice(long, O);
    policy.instructionWriteNotice(plain, O);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, 'took ' + ms + ' ms');
    assert.equal(policy.instructionWriteNotice(plain, O), null);
  });
});
