#!/usr/bin/env node
'use strict';
/**
 * Markdown table with the Linux and Windows reports of bench/hook_latency_matrix.js side by side.
 *
 *   node bench/hook_latency_summary.js linux.json windows.json
 *
 * A report that is missing or cannot be read shows as "n/a", so the table is still written when one
 * of the two jobs did not finish.
 */

const fs = require('fs');

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

const key = (r) => r.agent + ' | ' + r.case;
const num = (x) => (x === undefined ? 'n/a' : String(x));

function table(linux, windows) {
  const rows = new Map();
  for (const [name, rep] of [['linux', linux], ['windows', windows]]) {
    for (const r of (rep && rep.results) || []) {
      if (!rows.has(key(r))) rows.set(key(r), { agent: r.agent, case: r.case });
      rows.get(key(r))[name] = r;
    }
  }
  const out = ['### Hook latency, Linux and Windows', ''];
  for (const [name, rep] of [['Linux', linux], ['Windows', windows]]) {
    out.push('- ' + name + ': ' + (rep ? rep.meta.platform + ', ' + rep.meta.cpu + ', Node ' + rep.meta.node + ', bare node p50 ' + rep.meta.bareNodeP50 + ' ms' : 'no report'));
  }
  out.push('', '| agent | case | Linux p95 (ms) | Linux ratio | Windows p95 (ms) | Windows ratio |', '|---|---|---|---|---|---|');
  for (const r of rows.values()) {
    const l = r.linux || {};
    const w = r.windows || {};
    out.push('| ' + r.agent + ' | ' + r.case + ' | ' + num(l.p95) + ' | ' + num(l.ratio) + ' | ' + num(w.p95) + ' | ' + num(w.ratio) + ' |');
  }
  out.push('', 'The ratio is the p95 divided by the start-up time of a bare Node.js in the same run.');
  return out.join('\n') + '\n';
}

if (require.main === module) {
  const [linux, windows] = process.argv.slice(2);
  if (!linux || !windows) { console.error('usage: hook_latency_summary.js linux.json windows.json'); process.exit(2); }
  process.stdout.write(table(load(linux), load(windows)));
}
module.exports = { table };
