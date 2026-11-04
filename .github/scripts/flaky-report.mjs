#!/usr/bin/env node
// Flaky-test report for the scheduled "Flaky test tracker" workflow (.github/workflows/flaky-tests.yml).
//
// Reads the JUnit XML of repeated runs and lists the tests whose result changes between runs of the same
// operating system and suite: passed in one run, failed in another. Skipped results are not compared.
// A test that failed in every run is not flaky; it is counted and listed in the JSON as always failing.
//
//   node .github/scripts/flaky-report.mjs --in <dir> --out <dir> [--expected-runs 3]
//
// <dir> holds one file per run, named <os>--<suite>--run<n>.xml (for example ubuntu-latest--node--run1.xml),
// in any sub-folder. The report is written to <out>/flaky-report.json and <out>/flaky-report.md.
// Exit code: 0 when the report was written, 1 when no run file was read, 2 on bad arguments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_FILE = /^(.+?)--(.+?)--run(\d+)\.xml$/;
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_TABLE_ROWS = 200;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[name] ?? whole;
  });
}

function attributes(text) {
  const out = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

// Every <testcase> of a JUnit document, in order, as { file, name, status } with status pass, fail or skip.
// Node.js (--test-reporter=junit) and pytest (--junitxml) both write <testcase>; a failing or erroring case
// has a <failure> or <error> child, a skipped one a <skipped> child.
// Attribute values may contain a raw ">" (Node.js writes one in test names), so a tag is matched up to its
// closing quote-aware end, not up to the first ">".
const TAG_ATTRS = '((?:[^>"]|"[^"]*")*?)';

// The file as the repository shows it: "packages/..." when the path has that folder, else the last two segments
// of an absolute path (Node.js writes absolute paths).
export function normalizeFile(file) {
  const s = String(file).replace(/\\/g, '/');
  const pkg = /(?:^|\/)(packages\/.*)$/.exec(s);
  if (pkg) return pkg[1];
  if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) return s.split('/').slice(-2).join('/');
  return s;
}

// tests.test_cli.TestScan -> tests/test_cli.py (the trailing class names start with a capital letter).
function pythonFile(classname) {
  const parts = classname.split('.');
  while (parts.length > 1 && /^[A-Z]/.test(parts[parts.length - 1])) parts.pop();
  return `${parts.join('/')}.py`;
}

export function parseJunit(xml) {
  const cases = [];
  let firstSuite = null;
  const re = new RegExp(`<testsuite\\b${TAG_ATTRS}\\/?>|<testcase\\b${TAG_ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/testcase>)`, 'g');
  for (let m; (m = re.exec(xml)) !== null; ) {
    if (m[1] !== undefined) {
      if (firstSuite === null) firstSuite = attributes(m[1]).name ?? '';
      continue;
    }
    const a = attributes(m[2]);
    const body = m[3] ?? '';
    let status = 'pass';
    if (/<(failure|error)\b/.test(body)) status = 'fail';
    else if (/<skipped\b/.test(body)) status = 'skip';
    const classname = a.classname ?? '';
    // Node.js writes the file as its own attribute, or as the classname or suite name. pytest writes a dotted
    // classname (tests.test_cli.TestScan) and, in some versions, a file attribute.
    let raw;
    if (a.file) raw = a.file;
    else if (/\.[cm]?jsx?$|\.py$|\//.test(classname)) raw = classname;
    else if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(classname)) raw = pythonFile(classname);
    else raw = firstSuite ?? '';
    cases.push({ file: normalizeFile(raw), name: a.name ?? '', status });
  }
  return cases;
}

// A test name can repeat inside one run (node --test and pytest parametrize can both do it). The second and
// later copies get " (#n)" so that each one keeps its own identity across runs.
function identities(cases) {
  const seen = new Map();
  return cases.map((c) => {
    const base = `${c.file}\u0000${c.name}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? { ...c, key: base } : { ...c, key: `${base}\u0000#${n}`, name: `${c.name} (#${n})` };
  });
}

// runs: [{ os, suite, run, cases }]. Returns the report object (see renderMarkdown for the table).
export function buildReport(runs, { expectedRuns = 3 } = {}) {
  const groups = new Map();
  for (const r of runs) {
    const id = `${r.os}\u0000${r.suite}`;
    if (!groups.has(id)) groups.set(id, { os: r.os, suite: r.suite, runs: new Map() });
    const g = groups.get(id);
    if (g.runs.has(r.run)) throw new Error(`run ${r.run} of ${r.os} ${r.suite} was given twice`);
    g.runs.set(r.run, r.cases);
  }

  const warnings = [];
  const groupSummaries = [];
  const flaky = [];
  const alwaysFailing = [];
  const ordered = [...groups.values()].sort((a, b) => cmp(a.os, b.os) || cmp(a.suite, b.suite));
  for (const g of ordered) {
    const runNumbers = [...g.runs.keys()].sort((a, b) => a - b);
    const tests = new Map();
    for (const n of runNumbers) {
      const cases = g.runs.get(n);
      if (cases.length === 0) warnings.push(`${g.os} ${g.suite} run ${n}: no test case could be read`);
      for (const c of identities(cases)) {
        if (!tests.has(c.key)) tests.set(c.key, { file: c.file, name: c.name, byRun: {} });
        tests.get(c.key).byRun[n] = c.status;
      }
    }
    if (runNumbers.length < expectedRuns) {
      warnings.push(`${g.os} ${g.suite}: ${runNumbers.length} of ${expectedRuns} runs were read`);
    }

    const before = alwaysFailing.length;
    let flakyCount = 0;
    const sorted = [...tests.values()].sort((a, b) => cmp(a.file, b.file) || cmp(a.name, b.name));
    for (const t of sorted) {
      const statuses = runNumbers.map((n) => t.byRun[n] ?? 'missing');
      const decided = new Set(statuses.filter((s) => s === 'pass' || s === 'fail'));
      const entry = {
        os: g.os,
        suite: g.suite,
        file: t.file,
        name: t.name,
        byRun: Object.fromEntries(runNumbers.map((n, i) => [n, statuses[i]])),
      };
      if (decided.size === 2) {
        flaky.push(entry);
        flakyCount++;
      } else if (statuses.length > 0 && statuses.every((s) => s === 'fail')) {
        alwaysFailing.push(entry);
      }
    }
    groupSummaries.push({
      os: g.os,
      suite: g.suite,
      runs: runNumbers,
      tests: tests.size,
      flaky: flakyCount,
      failing_every_run: alwaysFailing.length - before,
    });
  }

  return {
    schema_version: 1,
    expected_runs: expectedRuns,
    groups: groupSummaries,
    flaky,
    always_failing: alwaysFailing,
    warnings,
  };
}

const cell = (s) =>
  String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMarkdown(report) {
  const lines = ['# Flaky test report', ''];
  lines.push(
    `Each suite ran ${report.expected_runs} times on each operating system. A test is flaky when it passes in one run ` +
      'and fails in another run of the same operating system and suite. Skipped results are not compared.',
    '',
  );
  lines.push('| OS | Suite | Runs | Tests | Flaky | Failing in every run |', '|---|---|---|---|---|---|');
  for (const g of report.groups) {
    lines.push(
      `| ${cell(g.os)} | ${cell(g.suite)} | ${g.runs.join(', ')} | ${g.tests} | ${g.flaky} | ${g.failing_every_run} |`,
    );
  }
  lines.push('');

  lines.push('## Flaky tests', '');
  if (report.flaky.length === 0) {
    lines.push('No test changed its result between runs.', '');
  } else {
    const runCols = [...new Set(report.groups.flatMap((g) => g.runs))].sort((a, b) => a - b);
    lines.push(`| OS | Suite | Test file | Test name | ${runCols.map((n) => `Run ${n}`).join(' | ')} |`);
    lines.push(`|---|---|---|---|${runCols.map(() => '---').join('|')}|`);
    for (const t of report.flaky.slice(0, MAX_TABLE_ROWS)) {
      const results = runCols.map((n) => cell(t.byRun[n] ?? '-')).join(' | ');
      lines.push(`| ${cell(t.os)} | ${cell(t.suite)} | ${cell(t.file)} | ${cell(t.name)} | ${results} |`);
    }
    if (report.flaky.length > MAX_TABLE_ROWS) {
      lines.push('', `... and ${report.flaky.length - MAX_TABLE_ROWS} more in flaky-report.json.`);
    }
    lines.push('');
  }

  const failing = report.always_failing.length;
  lines.push(
    `Tests that failed in every run (not flaky, listed in flaky-report.json): ${failing}.`,
    '',
  );
  if (report.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const w of report.warnings) lines.push(`- ${cell(w)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { in: null, out: null, expectedRuns: 3 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--in' || flag === '--out' || flag === '--expected-runs') {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === '--in') args.in = value;
      else if (flag === '--out') args.out = value;
      else args.expectedRuns = Number(value);
      i++;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!args.in || !args.out) throw new Error('usage: flaky-report.mjs --in <dir> --out <dir> [--expected-runs 3]');
  if (!Number.isInteger(args.expectedRuns) || args.expectedRuns < 1) throw new Error('--expected-runs must be a positive integer');
  return args;
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    error(e.message);
    return 2;
  }
  try {
    const runs = [];
    const ignored = [];
    for (const rel of fs.readdirSync(args.in, { recursive: true })) {
      const base = path.basename(String(rel));
      if (!base.endsWith('.xml')) continue;
      const m = RUN_FILE.exec(base);
      if (!m) {
        ignored.push(`ignored ${base}: the name is not <os>--<suite>--run<n>.xml`);
        continue;
      }
      const xml = fs.readFileSync(path.join(args.in, String(rel)), 'utf8');
      runs.push({ os: m[1], suite: m[2], run: Number(m[3]), cases: parseJunit(xml) });
    }
    if (runs.length === 0) {
      error(`no run files found under ${args.in}`);
      return 1;
    }
    const report = buildReport(runs, { expectedRuns: args.expectedRuns });
    report.warnings = [...ignored, ...report.warnings];
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'flaky-report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(args.out, 'flaky-report.md'), renderMarkdown(report));
    log(`flaky-report: ${report.flaky.length} flaky, ${report.always_failing.length} failing in every run, ${report.warnings.length} warnings`);
    return 0;
  } catch (e) {
    error(`flaky-report: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
