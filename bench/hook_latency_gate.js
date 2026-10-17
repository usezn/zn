'use strict';
/**
 * Latency budget for the agent hooks: compares a report of
 * bench/hook_latency_matrix.js with the committed baseline
 * (bench/hook_latency_baseline.json). A case fails when its p95, divided by
 * Node's own start-up time in the same run, is more than `maxIncrease`
 * (0.2 = 20 %) above the baseline. A case missing from the baseline, or from
 * the report, fails too, so the baseline is updated with every new case.
 *
 *   node bench/hook_latency_gate.js report.json [--baseline bench/hook_latency_baseline.json] [--max-increase 0.2]
 *   node bench/hook_latency_gate.js report.json --update-baseline   write the report's ratios as the baseline
 */

const fs = require('fs');
const path = require('path');

const key = (r) => r.agent + ' | ' + r.case;

/** 0 when every case is within budget, 1 otherwise; prints one line per case. */
function compare(report, baseline, maxIncrease, log = () => {}) {
  const base = new Map((baseline.results || []).map((r) => [key(r), r]));
  const seen = new Set();
  let fail = 0;
  for (const r of report.results) {
    seen.add(key(r));
    const b = base.get(key(r));
    if (!b) { log('FAIL ' + key(r) + ': not in the baseline (update it with --update-baseline)'); fail = 1; continue; }
    const limit = b.ratio * (1 + maxIncrease);
    // A ratio that is not a positive number (NaN, null, 0) cannot be checked, so it fails.
    const ok = [r.ratio, b.ratio].every((x) => Number.isFinite(x) && x > 0) && r.ratio <= limit;
    log((ok ? 'ok   ' : 'FAIL ') + key(r) + ': p95 ' + r.p95 + ' ms, ' + r.ratio + 'x node start-up (baseline ' + b.ratio + 'x, limit ' + limit.toFixed(3) + 'x)');
    if (!ok) fail = 1;
  }
  for (const k of base.keys()) if (!seen.has(k)) { log('FAIL ' + k + ': in the baseline but not measured'); fail = 1; }
  return fail;
}

/** The cases of the report that are over their limit (missing ones are not: they cannot be measured again). */
function overLimit(report, baseline, maxIncrease) {
  const base = new Map((baseline.results || []).map((r) => [key(r), r]));
  return report.results.filter((r) => base.has(key(r)) && r.ratio > base.get(key(r)).ratio * (1 + maxIncrease)).map(key);
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file || file.startsWith('--')) { console.error('usage: hook_latency_gate.js report.json [--baseline FILE] [--max-increase 0.2] [--update-baseline]'); process.exit(2); }
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const baselineFile = opt('--baseline', path.join(__dirname, 'hook_latency_baseline.json'));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args.includes('--update-baseline')) {
    const out = { _comment: 'p95 of each hook case divided by the p50 start-up of a bare node in the same run (bench/hook_latency_matrix.js). Update with: node bench/hook_latency_gate.js report.json --update-baseline', meta: report.meta, results: report.results.map((r) => ({ agent: r.agent, case: r.case, ratio: r.ratio })) };
    fs.writeFileSync(baselineFile, JSON.stringify(out, null, 2) + '\n');
    console.log('wrote ' + baselineFile);
    return;
  }
  process.exitCode = compare(report, JSON.parse(fs.readFileSync(baselineFile, 'utf8')), Number(opt('--max-increase', 0.2)), console.log);
}

if (require.main === module) main();
module.exports = { compare, overLimit };
