'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const markers = require('../lib/broker/markers');
const { moveTempRoot, assertFixturesOutsideTemp } = require('./_exe_fixture');
// The program checks refuse anything in a temp folder first: move the temp root away from the package so these fixtures reach them.
moveTempRoot();

const INSIDE = /inside the project/;

// Under the package: programs in a temp folder are refused before the checks under test (see _exe_fixture.js).
function withProject(fn) {
  const base = fs.mkdtempSync(path.join(__dirname, 'zn-resolved-exe-'));
  assertFixturesOutsideTemp(base);
  try {
    const project = path.join(base, 'project');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(project, 'bin'), { recursive: true });
    fs.mkdirSync(outside);
    fn({ project, outside });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('a resolved path inside the project is refused', () => {
  withProject(({ project }) => {
    const tool = path.join(project, 'bin', 'tool');
    fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
    assert.match(markers.checkResolvedExecutable(tool, project), INSIDE);
    assert.match(markers.checkResolvedExecutable(tool, project, fs.realpathSync(tool)), INSIDE);
  });
});

test('a program outside the project is accepted', () => {
  withProject(({ project, outside }) => {
    const tool = path.join(outside, 'tool');
    fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(markers.checkResolvedExecutable(tool, project), null);
  });
});

test('a link inside the project that points outside it is still refused by its name', { skip: process.platform === 'win32' }, () => {
  withProject(({ project, outside }) => {
    const target = path.join(outside, 'tool');
    const alias = path.join(project, 'bin', 'alias');
    fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(target, alias);
    assert.match(markers.checkResolvedExecutable(alias, project), INSIDE);
    // The caller may pass the real path it already resolved.
    assert.match(markers.checkResolvedExecutable(alias, project, fs.realpathSync(alias)), INSIDE);
  });
});

test('a link outside the project that points into it is refused by its real file', { skip: process.platform === 'win32' }, () => {
  withProject(({ project, outside }) => {
    const target = path.join(project, 'bin', 'tool');
    const alias = path.join(outside, 'alias');
    fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(target, alias);
    assert.match(markers.checkResolvedExecutable(alias, project), INSIDE);
  });
});

test('a path equal to the project root is refused', () => {
  withProject(({ project }) => {
    assert.match(markers.checkResolvedExecutable(project, project), INSIDE);
  });
});

test('an empty or missing path is reported as not found', () => {
  withProject(({ project }) => {
    for (const value of ['', null, undefined]) {
      assert.equal(markers.checkResolvedExecutable(value, project), 'command not found on PATH');
    }
    assert.equal(markers.checkResolvedExecutable('', ''), 'command not found on PATH');
  });
});
