#!/usr/bin/env node
'use strict';
/**
 * Step-by-step summary of a Gemini CLI end-to-end run, from what the provider
 * received (requests.jsonl). Fake values are replaced by their names before
 * printing. Exit 1 when a step does not match its `expect` in scenario.json:
 * "denied" = the result the model got must show that zn refused the call,
 * "ran" = it must not.
 *
 *   node summarize_gemini.js <run dir>
 */

const fs = require('fs');
const path = require('path');

const RUN = path.resolve(process.argv[2]);
const values = JSON.parse(fs.readFileSync(path.join(RUN, 'values.json'), 'utf8'));
const steps = JSON.parse(fs.readFileSync(path.join(RUN, 'scenario.json'), 'utf8')).steps;
const redact = (s) => {
  let out = String(s);
  for (const v of values) out = out.split(v.value).join('<<LEAK:' + v.name + '>>');
  return out.split(RUN).join('<run>');
};
const flat = (s) => redact(s).replace(/\s+/g, ' ').slice(0, 500);

const reqs = fs.readFileSync(path.join(RUN, 'out', 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const main = reqs.filter((r) => r.body && Array.isArray(r.body.tools) && r.body.tools.some((t) => t && t.functionDeclarations));
const last = main[main.length - 1];
const lines = ['requests to the provider: ' + reqs.length + ' (' + main.length + ' agent turns)'];
let bad = 0;
const calls = [];
const results = [];
for (const c of (last && last.body.contents) || []) {
  for (const p of c.parts || []) {
    if (p.functionCall) calls.push(p.functionCall);
    if (p.functionResponse) results.push(p.functionResponse);
  }
}
steps.forEach((s, i) => {
  const call = calls[i];
  const res = results[i];
  const text = res ? JSON.stringify(res.response) : '(no result)';
  const refused = /Tool execution blocked: zn/.test(text);
  const ok = Boolean(call && res) && (s.expect === 'denied' ? refused : !refused);
  if (!ok) bad++;
  lines.push('', 'step ' + (i + 1) + ': ' + (call ? call.name + ' ' + redact(JSON.stringify(call.args)) : '(not called)'),
    '  expected: ' + s.expect + (ok ? ' (matches)' : ' (DOES NOT MATCH)'), '  result: ' + flat(text));
});
lines.push('', bad ? 'MISMATCHES: ' + bad : 'every step matches');
process.stdout.write(lines.join('\n') + '\n');
process.exit(bad ? 1 : 0);
