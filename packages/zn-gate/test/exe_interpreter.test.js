'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isInterpreter, isInterpreterPath, interpreterBase } = require('../lib/exe');

const FAMILIES = [
  ['node', ['node', 'node18', 'node22.1', 'node-v20.11.0', 'nodejs']],
  ['python', ['python', 'python3', 'python3.12', 'python3.12m', 'python3.13t', 'python-3.11']],
  ['bash', ['bash', 'bash5', 'bash-5.2']],
  ['powershell', ['powershell', 'powershell5']],
  ['cmd', ['cmd']],
];

test('interpreterBase strips versions from node, python, bash, powershell and cmd', () => {
  for (const [base, names] of FAMILIES) {
    for (const n of names) {
      const want = n === 'nodejs' ? 'nodejs' : base;
      assert.equal(interpreterBase(n + ' script'), want, n);
    }
  }
});

test('interpreterBase handles .exe, .cmd and .bat suffixes', () => {
  assert.equal(interpreterBase('node.exe app.js'), 'node');
  assert.equal(interpreterBase('python3.12.exe app.py'), 'python');
  assert.equal(interpreterBase('powershell.exe -File a.ps1'), 'powershell');
  assert.equal(interpreterBase('cmd.exe /c dir'), 'cmd');
  assert.equal(interpreterBase('bash.exe -c true'), 'bash');
  assert.equal(interpreterBase('cmd.bat'), 'cmd');
});

test('interpreterBase ignores case', () => {
  assert.equal(interpreterBase('NODE22'), 'node');
  assert.equal(interpreterBase('Python3.12.EXE x.py'), 'python');
  assert.equal(interpreterBase('PowerShell.Exe'), 'powershell');
  assert.equal(interpreterBase('CMD.EXE /c dir'), 'cmd');
});

test('interpreterBase uses only the first word and handles empty input', () => {
  assert.equal(interpreterBase('  python3 -c "print(1)"'), 'python');
  assert.equal(interpreterBase('/usr/bin/bash -lc id'), 'bash');
  assert.equal(interpreterBase('C:\\Windows\\System32\\cmd.exe /c dir'), 'cmd');
  assert.equal(interpreterBase(''), '');
  assert.equal(interpreterBase(undefined), '');
  assert.equal(interpreterBase(null), '');
});

test('isInterpreter accepts versioned, suffixed and mixed-case command words', () => {
  for (const [, names] of FAMILIES) {
    for (const n of names) {
      assert.equal(isInterpreter(n), true, n);
      assert.equal(isInterpreter(n + '.exe'), true, n + '.exe');
      assert.equal(isInterpreter(n.toUpperCase() + '.EXE x'), true, n.toUpperCase());
    }
  }
  assert.equal(isInterpreter('Python3.12 script.py'), true);
  assert.equal(isInterpreter('/usr/bin/node22 app.js'), true);
});

test('isInterpreter rejects other programs and empty input', () => {
  for (const n of ['psql', 'git', 'nodemon', 'cmdline', 'bashful', 'pythonista', 'curl.exe', '']) {
    assert.equal(isInterpreter(n), false, n);
  }
  assert.equal(isInterpreter(undefined), false);
  assert.equal(isInterpreter(null), false);
});

test('isInterpreter judges only the first word of the command', () => {
  assert.equal(isInterpreter('psql -c python3'), false);
  assert.equal(isInterpreter('python3 psql'), true);
});

test('isInterpreterPath accepts the interpreters under directories with spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn exe '));
  try {
    const sub = path.join(dir, 'My Tools');
    fs.mkdirSync(sub);
    for (const n of ['node22', 'python3.12', 'bash', 'pwsh', 'cmd.exe']) {
      const file = path.join(sub, n);
      fs.writeFileSync(file, '');
      assert.equal(isInterpreterPath(file), true, file);
    }
    const other = path.join(sub, 'psql');
    fs.writeFileSync(other, '');
    assert.equal(isInterpreterPath(other), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isInterpreterPath handles Windows paths, suffixes and mixed case', () => {
  assert.equal(isInterpreterPath('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(isInterpreterPath('C:\\Program Files\\Python312\\Python3.12.EXE'), true);
  assert.equal(isInterpreterPath('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe'), true);
  assert.equal(isInterpreterPath('C:\\Windows\\System32\\CMD.EXE'), true);
  assert.equal(isInterpreterPath('C:\\Program Files\\Git\\bin\\bash.exe'), true);
  assert.equal(isInterpreterPath('C:\\Program Files\\PostgreSQL\\bin\\psql.exe'), false);
});

test('isInterpreterPath judges the file name, not the directories above it', () => {
  assert.equal(isInterpreterPath('/opt/python3/bin/psql'), false);
  assert.equal(isInterpreterPath('/opt/tools/node/'), false);
  assert.equal(isInterpreterPath(''), false);
  assert.equal(isInterpreterPath(undefined), false);
});
