'use strict';
// Cursor hook answers for a shell command that must run through zn, and for an MCP output rewrite with and without a note;
// the static launcher install when its folder cannot be made and when its test run does not answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const cursor = require('../lib/agents/cursor');
const sl = require('../lib/agents/static-launcher');

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-cov56-cursor-sl-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('cursor: a wrapped shell command is denied with the zn run form of the same command', () => {
  const r = cursor.respond({
    event: { event: 'shell', hookEvent: 'beforeShellExecution', input: { command: 'echo hi' } },
    decision: 'allow',
    kind: 'wrap',
    updatedInput: { command: 'zn run -- echo hi' },
  });
  assert.equal(r.permission, 'deny');
  assert.match(r.user_message, /zn run -- echo hi/);
  assert.equal(r.agent_message, r.user_message);
});

test('cursor: an MCP output rewrite keeps its note as additional context, and a structured output is passed as is', () => {
  const text = cursor.respond({
    event: { event: 'tool', hookEvent: 'postToolUse', tool: 'mcp' },
    decision: 'allow',
    updatedOutput: 'clean text',
    message: 'a note',
  });
  assert.deepEqual(text, { updated_mcp_tool_output: { text: 'clean text' }, additional_context: 'a note' });

  const obj = cursor.respond({
    event: { event: 'tool', hookEvent: 'postToolUse', tool: 'mcp' },
    decision: 'allow',
    updatedOutput: { content: [] },
  });
  assert.deepEqual(obj, { updated_mcp_tool_output: { content: [] } });
});

function nativeWith(bytes) {
  const nativeDir = fs.mkdtempSync(path.join(ROOT, 'native-'));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(path.join(nativeDir, 'linux-x64'), { recursive: true });
  fs.writeFileSync(path.join(nativeDir, 'linux-x64', sl.NAME), bytes);
  fs.writeFileSync(path.join(nativeDir, 'hook-launcher.json'), JSON.stringify({ 'linux-x64': sha }));
  return nativeDir;
}

test('static launcher: a hooks folder that cannot be created is a warning, never a throw', () => {
  const nativeDir = nativeWith('#!/bin/sh\nexit 0\n');
  const home = path.join(ROOT, 'home-is-a-file');
  fs.writeFileSync(home, 'not a folder');
  const r = sl.installStatic({ platform: 'linux', arch: 'x64', nativeDir, env: {}, home });
  assert.ok(r.warning, JSON.stringify(r));
  assert.match(r.warning, /it could not be written to/);
  assert.equal(r.file, undefined);
});

test('static launcher: a copy whose test run does not answer the expected way is a warning', () => {
  const nativeDir = nativeWith('#!/bin/sh\nexit 0\n');
  const home = fs.mkdtempSync(path.join(ROOT, 'home-'));
  const r = sl.installStatic({ platform: 'linux', arch: 'x64', nativeDir, env: {}, home });
  assert.ok(r.warning, JSON.stringify(r));
  assert.match(r.warning, /the launcher did not answer its test run/);
});
