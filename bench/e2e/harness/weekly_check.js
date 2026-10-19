#!/usr/bin/env node
'use strict';
/**
 * Contract check for the weekly agent compatibility run.
 *
 * Compares the evidence a fresh run of harness/run_all.sh wrote with the
 * evidence committed in bench/e2e/<agent>/, ignoring wording the agents own
 * (error text, timings, ids). A case is "the same" when every step has the
 * same tool name, the same error flag, the same __ZN_ tokens in the result
 * and the same zn notes count, and when the exit codes and the vault answers
 * match. It also fails when anything sent to the provider holds a fake secret
 * (the leak check), or when an agent produced no evidence.
 *
 *   node weekly_check.js <baseline dir> <fresh dir> <out json> <out markdown> [agent ...]
 *
 * Both dirs hold one folder per agent (claude-code, codex, opencode). The
 * optional agent names limit the check to those agents.
 */
const fs = require('fs');
const path = require('path');

const [baseDir, newDir, outJson, outMd, ...only] = process.argv.slice(2);
const ALL = ['claude-code', 'codex', 'opencode'];
const AGENTS = only.length ? ALL.filter((a) => only.includes(a)) : ALL;

const read = (d, a, f) => {
  try { return fs.readFileSync(path.join(d, a, f), 'utf8'); } catch (e) { return null; }
};

function steps(text) {
  const out = [];
  let cur = null;
  let notes = 0;
  let inNotes = false;
  for (const line of text.split('\n')) {
    const m = /^step (\d+): (\S+)/.exec(line);
    if (m) { cur = { n: Number(m[1]), tool: m[2].toLowerCase(), error: false, tokens: '', hook: false }; out.push(cur); inNotes = false; continue; }
    if (/^zn notes the model saw/.test(line)) { inNotes = true; cur = null; continue; }
    if (inNotes) { if (/^\s+- /.test(line)) notes++; continue; }
    const r = /^\s+result( \(error\))?:\s?(.*)$/.exec(line);
    if (r && cur) {
      cur.error = !!r[1];
      cur.tokens = [...new Set(r[2].match(/__ZN_[A-Z0-9_]+__/g) || [])].sort().join(',');
      cur.hook = /\bzn( run)?:|ZN_POLICY_DENIED|PreToolUse/.test(r[2]);
    }
  }
  return { steps: out.map((s) => [s.n, s.tool, s.error ? 'error' : 'ok', s.tokens, s.hook ? 'zn' : '-'].join('|')), notes };
}

const answers = (t) => (t || '').split('\n').filter(Boolean).map((l) => {
  try { const j = JSON.parse(l); return j.kind + ':' + j.answer; } catch (e) { return 'unparsed'; }
});

const codes = (t) => (t || '').split('\n').filter(Boolean).map((l) => l.replace(/\s+/g, ' ').trim());

const result = { agents: {}, ok: true };
for (const a of AGENTS) {
  const r = { cases: [], ok: true, problems: [] };
  result.agents[a] = r;
  const nSum = read(newDir, a, 'summary.txt');
  const bSum = read(baseDir, a, 'summary.txt');
  const nLeak = read(newDir, a, 'leak-check.txt');
  if (nSum === null || nLeak === null) {
    r.ok = false;
    r.problems.push('no evidence produced (the agent did not run)');
    continue;
  }
  const run = read(newDir, a, 'run.txt') || '';
  r.version = (/agent version: (.*)/.exec(run) || [])[1] || 'unknown';

  // Nothing sent to the provider contains a fake secret.
  const sent = /^sent: (\d+) file\(s\), (\d+) finding\(s\)/m.exec(nLeak);
  const sentOk = !!sent && Number(sent[1]) >= 1 && Number(sent[2]) === 0;
  r.cases.push({ name: 'no secret value sent to the provider', ok: sentOk, detail: sent ? sent[0] : 'leak check missing' });

  // Hook contract: what each tool step did, as the model saw it.
  const nS = steps(nSum);
  if (bSum === null) {
    r.cases.push({ name: 'hook contract', ok: false, detail: 'no committed baseline' });
  } else {
    const bS = steps(bSum);
    const diff = [];
    const len = Math.max(nS.steps.length, bS.steps.length);
    for (let i = 0; i < len; i++) {
      if (nS.steps[i] !== bS.steps[i]) diff.push('step ' + (i + 1) + ': expected "' + (bS.steps[i] || '(none)') + '", got "' + (nS.steps[i] || '(none)') + '"');
    }
    if (nS.notes !== bS.notes) diff.push('zn notes: expected ' + bS.notes + ', got ' + nS.notes);
    r.cases.push({ name: 'hook contract (' + bS.steps.length + ' steps)', ok: diff.length === 0, detail: diff.join('; ') || 'same as the committed evidence' });
  }

  const nx = codes(read(newDir, a, 'exit-codes.txt'));
  const bx = codes(read(baseDir, a, 'exit-codes.txt'));
  r.cases.push({ name: 'exit codes', ok: JSON.stringify(nx) === JSON.stringify(bx), detail: 'expected [' + bx.join(', ') + '], got [' + nx.join(', ') + ']' });

  const na = answers(read(newDir, a, 'confirmations.jsonl'));
  const ba = answers(read(baseDir, a, 'confirmations.jsonl'));
  r.cases.push({ name: 'vault confirmations', ok: JSON.stringify(na) === JSON.stringify(ba), detail: 'expected [' + ba.join(', ') + '], got [' + na.join(', ') + ']' });

  r.ok = r.cases.every((c) => c.ok);
}
result.ok = AGENTS.every((a) => result.agents[a].ok);
fs.writeFileSync(outJson, JSON.stringify(result, null, 2) + '\n');

const md = ['## Weekly agent compatibility', '', '| Agent | Version tested | Result |', '|---|---|---|'];
for (const a of AGENTS) md.push('| ' + a + ' | ' + (result.agents[a].version || 'not run') + ' | ' + (result.agents[a].ok ? 'PASS' : 'FAIL') + ' |');
md.push('');
for (const a of AGENTS) {
  const r = result.agents[a];
  md.push('### ' + a, '');
  r.problems.forEach((p) => md.push('- FAIL: ' + p));
  r.cases.forEach((c) => md.push('- ' + (c.ok ? 'PASS' : 'FAIL') + ': ' + c.name + (c.ok ? '' : ' (' + c.detail + ')')));
  md.push('');
}
fs.writeFileSync(outMd, md.join('\n'));
process.stdout.write(md.join('\n') + '\n');
process.exitCode = result.ok ? 0 : 1;
