#!/usr/bin/env node
'use strict';
// Runs every test of the package, in order, and stops at the first failure.
//
//   1. the files named in test/runner-plain.json, each with plain `node <file>`
//   2. every other test/*.test.js, together under `node --test`
//   3. test/integration/test_agent_workflows.js
//   4. `node bin/cli.js test`
//
// A new test/*.test.js is picked up by step 2 without touching package.json.
// Files that must run with plain `node` are listed in runner-plain.json.
//
//   node test/run-all.js          run everything
//   node test/run-all.js --list   print the steps without running them
//
// A skipped test passes, so a test that quietly stops running looks green. The runner counts the skips
// in every step and prints the total. When CI is set, a skip that test/expected-skips.json does not list
// for the current platform fails the run (each entry carries the reason the skip is legitimate there).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const testDir = __dirname;

// test/*.test.js files that are not tests of their own (none today).
// Add a name here with a comment saying why.
const EXCLUDE = [];

// Test-looking files that have their own explicit step.
const EXPLICIT = ['integration/test_agent_workflows.js'];
const TEST_NAME = /(\.test\.[cm]?js|_test\.js)$/;

function walk(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

// Files under dir that look like tests but no step runs (paths relative to dir).
function uncovered(dir, { plain, harness, exclude }) {
  const covered = new Set([...plain, ...harness, ...exclude, ...EXPLICIT]);
  return walk(dir, '').filter((f) => TEST_NAME.test(f) && !covered.has(f)).sort();
}

function load() {
  const plain = JSON.parse(fs.readFileSync(path.join(testDir, 'runner-plain.json'), 'utf8'));
  if (!Array.isArray(plain) || plain.some((f) => typeof f !== 'string')) {
    throw new Error('runner-plain.json must be an array of file names');
  }
  const missing = plain.filter((f) => !fs.existsSync(path.join(testDir, f)));
  if (missing.length) throw new Error('runner-plain.json names missing files: ' + missing.join(', '));
  const dup = plain.filter((f, i) => plain.indexOf(f) !== i);
  if (dup.length) throw new Error('runner-plain.json lists a file twice: ' + dup.join(', '));
  const bad = EXCLUDE.filter((f) => !fs.existsSync(path.join(testDir, f)));
  if (bad.length) throw new Error('EXCLUDE names missing files: ' + bad.join(', '));

  const discovered = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
  const harness = discovered.filter((f) => !plain.includes(f) && !EXCLUDE.includes(f));

  const rel = (f) => 'test/' + f;
  const steps = [];
  for (const f of plain) steps.push({ label: rel(f), args: [rel(f)] });
  if (!harness.length) throw new Error('no test/*.test.js files found for node --test');
  steps.push({ label: 'node --test (' + harness.length + ' files)', args: ['--test', ...harness.map(rel)], files: harness.map(rel) });
  steps.push({ label: 'test/integration/test_agent_workflows.js', args: ['test/integration/test_agent_workflows.js'] });
  steps.push({ label: 'bin/cli.js test', args: ['bin/cli.js', 'test'] });

  const lost = uncovered(testDir, { plain, harness, exclude: EXCLUDE });
  if (lost.length) throw new Error('test files not run by any step: ' + lost.join(', '));
  return steps;
}


// Skipped tests in the output of node:test, in the TAP form (`ok 3 - name # SKIP reason`) and in the
// spec form (`﹣ name (0.1ms) # reason`). Both are read, as the default reporter depends on the Node.js version.
const TAP_SKIP = /^\s*(?:not )?ok \d+ - (.+?)\s+# SKIP\b\s*(.*)$/i;
const SPEC_SKIP = /^\s*\u{FE63} (.+?)(?: \(\d[\d.]*m?s\))?(?: # (.*))?$/u;

function parseSkips(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = TAP_SKIP.exec(line) || SPEC_SKIP.exec(line);
    if (m) out.push({ name: m[1].trim(), reason: (m[2] || '').trim() });
  }
  return out;
}

function loadExpected(file) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error('expected-skips.json must be an array');
  for (const e of list) {
    if (!e || typeof e.test !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) {
      throw new Error('expected-skips.json: every entry needs "test" and a non-empty "reason"');
    }
    if (!Array.isArray(e.platforms) || !e.platforms.length || e.platforms.some((x) => typeof x !== 'string')) {
      throw new Error('expected-skips.json: every entry needs "platforms" (process.platform values or "*")');
    }
    new RegExp(e.test); // fail early on a bad pattern
  }
  return list;
}

// The skips that no entry of the list covers on this platform.
function unexpectedSkips(skips, expected, platform) {
  return skips.filter((s) => !expected.some((e) => (e.platforms.includes('*') || e.platforms.includes(platform)) && new RegExp(e.test).test(s.name)));
}

function runStep(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], shell: false });
    let text = '';
    child.stdout.on('data', (d) => { text += d; process.stdout.write(d); });
    child.on('error', (error) => resolve({ error, status: null, signal: null, text }));
    child.on('close', (status, signal) => resolve({ status, signal, text }));
  });
}

async function main() {
  const steps = load();
  if (process.argv.includes('--list')) {
    for (const s of steps) {
      if (s.files) for (const f of s.files) console.log(f);
      else console.log(s.args.join(' '));
    }
    return 0;
  }
  let n = 0;
  const skips = [];
  for (const s of steps) {
    console.log('\n=== ' + s.label + ' ===');
    const r = await runStep(s.args);
    for (const k of parseSkips(r.text)) skips.push({ ...k, step: s.label });
    if (r.error || r.status !== 0) {
      console.error('\nFAILED: ' + s.label + (r.error ? ' (' + r.error.message + ')' : ' (exit ' + (r.status === null ? 'signal ' + r.signal : r.status) + ')'));
      return r.status || 1;
    }
    n++;
  }
  console.log('\nOK: ' + n + ' steps passed, ' + skips.length + ' tests skipped');
  if (process.env.CI) {
    const bad = unexpectedSkips(skips, loadExpected(path.join(testDir, 'expected-skips.json')), process.platform);
    if (bad.length) {
      console.error('\nFAILED: ' + bad.length + ' skipped test(s) are not in test/expected-skips.json for ' + process.platform + ':');
      for (const k of bad) console.error('  - ' + k.name + (k.reason ? ' (' + k.reason + ')' : '') + '  [' + k.step + ']');
      console.error('A skip passes silently. Fix what made the test skip, or add it to the list with the reason it is expected here.');
      return 1;
    }
  } else if (skips.length) {
    console.log('(set CI=1 to fail on skips that test/expected-skips.json does not list)');
  }
  return 0;
}

module.exports = { uncovered, parseSkips, unexpectedSkips, loadExpected };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error('run-all: ' + e.message);
    process.exitCode = 1;
  });
}
