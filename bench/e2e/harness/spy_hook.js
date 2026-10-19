#!/usr/bin/env node
'use strict';
/**
 * Wraps one hook command for a run: logs what Codex sent on stdin and what
 * the real hook answered (stdout, exit code) to the log file, and passes both
 * through unchanged.
 *
 *   node spy_hook.js <log file> <hook command...>
 */

const fs = require('fs');
const { spawn } = require('child_process');

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const child = spawn('/bin/sh', ['-c', process.argv.slice(3).join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code) => {
    let input = null;
    try { input = JSON.parse(raw); } catch (_) { /* keep raw */ }
    {
      fs.appendFileSync(process.argv[2], JSON.stringify({ ts: new Date().toISOString(), input: input || raw, stdout: out, stderr: err, exit: code }) + '\n');
    }
    process.stdout.write(out);
    process.stderr.write(err);
    process.exitCode = code === null ? 1 : code;
  });
  child.stdin.end(raw);
});
