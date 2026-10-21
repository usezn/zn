#!/usr/bin/env node
'use strict';

// Measures the optional destructive-command policy on the labeled corpus
// (packages/zn-gate/test/fixtures/destructive_commands.json):
//   false positives   benign commands the policy blocks
//   true positives    risky commands it blocks, with the rule it names
//   latency           checkCommand alone, and the whole hook check (bashDenial) with the policy off and on
//
//   node bench/destructive_policy.js            print the report
//   node bench/destructive_policy.js --json     print it as JSON
//   node bench/destructive_policy.js --verbose  also list every false positive and miss
//   node bench/destructive_policy.js --docs     also run the policy over the shell lines in this repository's Markdown
//                                               files (README, docs, package READMEs): real commands that people copy

const path = require('path');
const pkg = path.resolve(__dirname, '..', 'packages', 'zn-gate');
const corpus = require(path.join(pkg, 'test', 'fixtures', 'destructive_commands.json'));
const { checkCommand } = require(path.join(pkg, 'lib', 'destructive.js'));
const policy = require(path.join(pkg, 'lib', 'hooks', 'policy.js'));

const verbose = process.argv.includes('--verbose');

const falsePositives = corpus.benign.map((c) => ({ cmd: c, res: checkCommand(c) })).filter((x) => x.res.verdict === 'block');
const byRule = {};
const misses = [];
let wrongRule = 0;
for (const r of corpus.risky) {
  const res = checkCommand(r.cmd);
  const row = (byRule[r.rule] = byRule[r.rule] || { total: 0, blocked: 0 });
  row.total++;
  if (res.verdict === 'block') {
    row.blocked++;
    if (res.rule !== 'destructive:' + r.rule) wrongRule++;
  } else misses.push(r);
}
const notCoveredBlocked = corpus.not_covered.filter((x) => checkCommand(x.cmd).verdict === 'block');

function time(fn, list, rounds) {
  for (const c of list) fn(c); // warm up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) for (const c of list) fn(c);
  return Number(process.hrtime.bigint() - t0) / 1000 / (rounds * list.length); // microseconds per command
}
const all = corpus.benign.concat(corpus.risky.map((r) => r.cmd));
const opts = { cwd: process.cwd(), home: '/home/example-user' };
const latency = {
  commands: all.length,
  checkCommand_us: Math.round(time((c) => checkCommand(c), all, 20) * 10) / 10,
  hook_policy_off_us: Math.round(time((c) => policy.bashDenial(c, { ...opts, destructiveRules: [] }), corpus.benign, 3) * 10) / 10,
  hook_policy_on_us: Math.round(time((c) => policy.bashDenial(c, { ...opts, destructiveRules: require('../packages/zn-gate/lib/destructive').RULES.map((r) => r.replace('destructive:', '')) }), corpus.benign, 3) * 10) / 10,
};

const tp = corpus.risky.length - misses.length;
const report = {
  benign: { total: corpus.benign.length, false_positives: falsePositives.length },
  risky: { total: corpus.risky.length, blocked: tp, missed: misses.length, wrong_rule: wrongRule, by_rule: byRule },
  not_covered: { total: corpus.not_covered.length, blocked: notCoveredBlocked.length },
  latency,
};

// Shell lines of the fenced code blocks (bash, sh, shell, zsh, console, powershell, pwsh) of the repository's Markdown files.
function docLines() {
  const fs = require('fs');
  const root = path.resolve(__dirname, '..');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'target') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  })(root);
  const lines = [];
  for (const f of files) {
    let lang = null;
    let pending = '';
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const fence = /^\s*```\s*([A-Za-z0-9_-]*)/.exec(raw);
      if (fence) { lang = lang === null ? fence[1].toLowerCase() : null; pending = ''; continue; }
      if (lang === null || !/^(?:bash|sh|shell|zsh|console|powershell|pwsh|ps1|cmd)$/.test(lang)) continue;
      let line = raw.replace(/^\s*(?:\$|PS>|>)\s+/, '').trim();
      if (!line || line.startsWith('#')) continue;
      if (line.endsWith('\\')) { pending += line.slice(0, -1) + ' '; continue; }
      line = pending + line;
      pending = '';
      lines.push({ file: path.relative(root, f), line });
    }
  }
  return lines;
}
if (process.argv.includes('--docs')) {
  const lines = docLines();
  const hits = lines.filter((l) => checkCommand(l.line).verdict === 'block');
  report.docs = { lines: lines.length, blocked: hits.length };
  if (!process.argv.includes('--json')) {
    console.log(`Repository docs: ${lines.length} shell lines, ${hits.length} blocked`);
    for (const h of hits) console.log('  ' + checkCommand(h.line).rule + '  ' + h.file + ': ' + h.line);
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Benign corpus:  ${report.benign.total} commands, ${report.benign.false_positives} false positives`);
  console.log(`Risky corpus:   ${report.risky.total} commands, ${tp} blocked, ${misses.length} missed, ${wrongRule} blocked under another rule`);
  for (const [rule, row] of Object.entries(byRule)) console.log(`  ${rule.padEnd(16)} ${row.blocked}/${row.total}`);
  console.log(`Not covered:    ${report.not_covered.total} commands the policy is not meant to read, ${notCoveredBlocked.length} blocked`);
  console.log(`Latency per command: checkCommand ${latency.checkCommand_us} us; hook check (benign set) ${latency.hook_policy_off_us} us off, ${latency.hook_policy_on_us} us on`);
}
if (verbose) {
  for (const f of falsePositives) console.log('FALSE POSITIVE', f.res.rule, JSON.stringify(f.cmd));
  for (const m of misses) console.log('MISS', m.rule, JSON.stringify(m.cmd));
  for (const n of notCoveredBlocked) console.log('NOT-COVERED BLOCKED', JSON.stringify(n.cmd));
}
