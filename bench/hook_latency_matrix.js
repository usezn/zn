#!/usr/bin/env node
'use strict';
/**
 * Hook latency by agent, event and output size: each sample starts
 * `node lib/hooks/runner.js <agent>` with the event on stdin, as the agent
 * does, and times it until the process exits. The vault is locked (a fresh
 * ZN_HOME with no daemon), so detected values are redacted for good and the
 * numbers do not depend on a background process.
 *
 *   node bench/hook_latency_matrix.js [--runs 40] [--json out.json] [--baseline file] [--max-increase 0.2]
 *
 * Each case also gets `ratio`: its p95 divided by the p50 start-up time of a
 * bare `node -e ""` measured in the same run. CI compares the ratios with a
 * committed baseline (--baseline), which cancels most of the speed difference
 * between machines, and fails when a case is more than --max-increase slower.
 * Fake values are generated at run time; a case fails if one of them comes back.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PKG = path.resolve(__dirname, '..', 'packages', 'zn-gate');
const RUNNER = path.join(PKG, 'lib', 'hooks', 'runner.js');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const RUNS = Number(arg('--runs', 40));
const JSON_OUT = arg('--json', null);
const BASELINE = arg('--baseline', null);
const MAX_INCREASE = Number(arg('--max-increase', 0.2));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hookmatrix-'));
const ENV = { ...process.env, ZN_HOME: HOME, HOME, USERPROFILE: HOME, ZN_STATS: 'off', ZN_KEYCHAIN_BACKEND: 'passphrase' };

const { generateAll } = require(path.join(PKG, 'test', 'fixtures', 'fake_secrets'));
const FAKE = generateAll(31337, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const GHP = FAKE.secrets.find((s) => s.type === 'github_pat_classic').value;

/* Source-like tool output of about `bytes` characters, optionally with two fake secrets inside. */
function output(bytes, withSecrets) {
  const lines = [];
  let size = 0;
  for (let n = 0; size < bytes; n++) {
    const l = '  ' + (n % 7 === 0 ? 'const handler_' + n + ' = require("./mod_' + n + '");' : 'logger.info("request " + id + " took " + ms + "ms", { route: "/api/v1/items/' + n + '" });');
    lines.push(l);
    size += l.length + 1;
  }
  if (withSecrets) {
    lines[Math.floor(lines.length / 3)] = 'AWS_ACCESS_KEY_ID=' + AWS;
    lines[Math.floor((2 * lines.length) / 3)] = 'token: ' + GHP;
  }
  return lines.join('\n').slice(0, bytes);
}

const SIZES = [['1 KB', 1024, false], ['100 KB', 100 * 1024, false], ['100 KB with 2 secrets', 100 * 1024, true], ['1000 KB', 1000 * 1024, false]];

function cases() {
  const out = [];
  const pre = { session_id: 'bench', cwd: HOME, tool_use_id: 't' };
  out.push(['claude-code', 'PreToolUse Bash', { ...pre, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }]);
  out.push(['codex', 'PreToolUse Bash', { ...pre, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }]);
  out.push(['cursor', 'beforeShellExecution', { conversation_id: 'bench', generation_id: 'g', hook_event_name: 'beforeShellExecution', cwd: HOME, command: 'npm test' }]);
  for (const [label, bytes, secrets] of SIZES) {
    const text = output(bytes, secrets);
    out.push(['claude-code', 'PostToolUse Bash ' + label, { ...pre, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/app.js' }, tool_response: { stdout: text, stderr: '', interrupted: false, isImage: false } }]);
    out.push(['codex', 'PostToolUse Bash ' + label, { ...pre, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/app.js' }, tool_response: { stdout: text, stderr: '' } }]);
    out.push(['cursor', 'postToolUse MCP ' + label, { conversation_id: 'bench', generation_id: 'g', hook_event_name: 'postToolUse', tool_name: 'MCP:get_file', tool_input: {}, tool_output: JSON.stringify({ content: [{ type: 'text', text }] }) }]);
  }
  return out;
}

function once(agent, event) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [RUNNER, agent], { env: ENV, cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, out, err }));
    child.stdin.end(JSON.stringify(event));
  });
}

function bareNode() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }).on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
  });
}

// Nearest-rank percentile: with 40 samples the p95 is the 38th, not the slowest one.
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

/*
 * The hook must have done its work: no fake value back (stdout or stderr), no "could not check" refusal, and,
 * when the output holds secrets, a zn marker in place of them. A hook that fails closed is fast but measures
 * nothing.
 */
function checkWork(agent, label, r, withSecrets) {
  const all = r.out + r.err;
  if (all.includes(AWS) || all.includes(GHP)) throw new Error('a fake secret came back from the hook: ' + agent + ' ' + label);
  if (/could not check|output withheld|was hidden/i.test(all)) throw new Error('the hook could not check the output: ' + agent + ' ' + label);
  if (withSecrets && !all.includes('__ZN_')) throw new Error('the hook did not redact the secrets: ' + agent + ' ' + label);
}

/* p50 and p95 of one case over `runs` samples, with Node's start-up measured between the samples. */
async function measure(agent, label, event, runs) {
  checkWork(agent, label, await once(agent, event), /with 2 secrets/.test(label)); // also warms the file cache
  const times = [];
  const bare = [];
  for (let i = 0; i < runs; i++) {
    const r = await once(agent, event);
    times.push(r.ms);
    checkWork(agent, label, r, /with 2 secrets/.test(label));
    // Node start-up measured between the samples, so both see the same machine load.
    bare.push(await bareNode());
  }
  times.sort((a, b) => a - b);
  bare.sort((a, b) => a - b);
  return { agent, case: label, p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1), bare };
}

async function main() {
  const list = cases();
  const results = [];
  for (const [agent, label, event] of list) results.push(await measure(agent, label, event, RUNS));
  const allBare = results.flatMap((r) => r.bare).sort((a, b) => a - b);
  const nodeP50 = +pct(allBare, 50).toFixed(1);
  for (const r of results) { r.ratio = +(r.p95 / nodeP50).toFixed(3); delete r.bare; }
  const meta = {
    date: new Date().toISOString().slice(0, 10), node: process.version, platform: process.platform + ' ' + os.release(),
    cpu: (os.cpus()[0] || {}).model + ' x' + os.cpus().length, runs: RUNS, bareNodeP50: nodeP50,
  };
  const report = { meta, results };
  console.log('Hook latency (ms), ' + meta.platform + ', ' + meta.cpu + ', Node ' + meta.node + ', ' + RUNS + ' runs; bare node p50 ' + nodeP50 + ' ms');
  console.log('| agent | case | p50 | p95 | p95 / node start-up |\n|---|---|---|---|---|');
  for (const r of results) console.log('| ' + r.agent + ' | ' + r.case + ' | ' + r.p50 + ' | ' + r.p95 + ' | ' + r.ratio + ' |');
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n');
  if (!BASELINE) fs.rmSync(HOME, { recursive: true, force: true });
  if (BASELINE) {
    const gate = require('./hook_latency_gate');
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    // One slow sample can move a p95: a case over the limit is measured again with twice the samples, and
    // fails only if it is still over.
    const over = gate.overLimit(report, baseline, MAX_INCREASE);
    if (over.length) {
      console.log('\nMeasured again (' + RUNS * 2 + ' runs): ' + over.join(', '));
      for (const k of over) {
        const [agent, label, event] = list.find(([a, l]) => a + ' | ' + l === k);
        const again = await measure(agent, label, event, RUNS * 2);
        const i = report.results.findIndex((r) => r.agent + ' | ' + r.case === k);
        // The same divisor as the first pass, so the ratio means the same thing as in the baseline.
        report.results[i] = { agent, case: label, p50: again.p50, p95: again.p95, ratio: +(again.p95 / nodeP50).toFixed(3), remeasured: true };
      }
      if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n');
    }
    process.exitCode = gate.compare(report, baseline, MAX_INCREASE, console.log);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
