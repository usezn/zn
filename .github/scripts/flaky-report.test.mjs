// Unit tests for flaky-report.mjs. Run with: node --test .github/scripts/flaky-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, main, normalizeFile, parseJunit, renderMarkdown } from './flaky-report.mjs';

// A JUnit document in the shape node --test --test-reporter=junit writes: one <testsuite> per file.
// cases: [name, status] with status pass | fail | skip.
function nodeJunit(file, cases) {
  const body = cases
    .map(([name, status]) => {
      const attrs = `name="${name}" classname="${file}" time="0.01"`;
      if (status === 'fail') return `    <testcase ${attrs}><failure message="boom" type="testCodeFailure">boom &amp; more</failure></testcase>`;
      if (status === 'skip') return `    <testcase ${attrs}><skipped message="later"/></testcase>`;
      return `    <testcase ${attrs}/>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="node test tests" tests="${cases.length}">
  <testsuite name="${file}" tests="${cases.length}">
${body}
  </testsuite>
</testsuites>
`;
}

// A JUnit document in the shape pytest --junitxml writes, with the file attribute.
function pytestJunit(cases) {
  const body = cases
    .map(([file, name, status]) => {
      const attrs = `classname="tests.test_cli.TestScan" name="${name}" file="${file}" line="10" time="0.2"`;
      if (status === 'fail') return `    <testcase ${attrs}><failure message="too slow">assert 2 &lt; 1</failure></testcase>`;
      return `    <testcase ${attrs}/>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" errors="0" failures="0" tests="${cases.length}" skipped="0">
${body}
  </testsuite>
</testsuites>
`;
}

const run = (osName, suite, n, cases) => ({ os: osName, suite, run: n, cases: parseJunit(cases) });

test('parseJunit reads pass, fail and skip from node --test output and decodes entities', () => {
  const cases = parseJunit(
    nodeJunit('test/alpha.test.js', [
      ['adds', 'pass'],
      ['breaks', 'fail'],
      ['waits', 'skip'],
    ]),
  );
  assert.deepEqual(cases, [
    { file: 'test/alpha.test.js', name: 'adds', status: 'pass' },
    { file: 'test/alpha.test.js', name: 'breaks', status: 'fail' },
    { file: 'test/alpha.test.js', name: 'waits', status: 'skip' },
  ]);
});

test('parseJunit reads the file attribute and the name of pytest output', () => {
  const cases = parseJunit(
    pytestJunit([
      ['tests/test_cli.py', 'test_linear[a&amp;b]', 'fail'],
      ['tests/test_cli.py', 'test_other', 'pass'],
    ]),
  );
  assert.deepEqual(cases, [
    { file: 'tests/test_cli.py', name: 'test_linear[a&b]', status: 'fail' },
    { file: 'tests/test_cli.py', name: 'test_other', status: 'pass' },
  ]);
});

test('pytest output without a file attribute: the file comes from the dotted classname', () => {
  const xml = `<testsuites><testsuite name="pytest" tests="2">
<testcase classname="tests.test_cli" name="test_ok" time="0.0" />
<testcase classname="tests.test_cli.TestScan" name="test_big[a&amp;b]" time="0.0"><failure message="x">x</failure></testcase>
</testsuite></testsuites>`;
  assert.deepEqual(parseJunit(xml), [
    { file: 'tests/test_cli.py', name: 'test_ok', status: 'pass' },
    { file: 'tests/test_cli.py', name: 'test_big[a&b]', status: 'fail' },
  ]);
});

test('node output with a raw ">" in a test name and absolute file paths is read', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="fails &amp; escapes &lt;x>" time="0.05" classname="test" file="/srv/work/packages/zn-gate/test/a.test.js" failure="boom">
\t\t<failure type="testCodeFailure" message="boom">boom</failure>
\t</testcase>
\t<testcase name="passes" time="0.01" classname="test" file="/srv/work/packages/zn-gate/test/a.test.js"/>
</testsuites>
`;
  assert.deepEqual(parseJunit(xml), [
    { file: 'packages/zn-gate/test/a.test.js', name: 'fails & escapes <x>', status: 'fail' },
    { file: 'packages/zn-gate/test/a.test.js', name: 'passes', status: 'pass' },
  ]);
  assert.equal(normalizeFile('D:\\a\\zn\\zn\\packages\\zn-gate\\test\\b.test.js'), 'packages/zn-gate/test/b.test.js');
  assert.equal(normalizeFile('/opt/x/y/c.test.js'), 'y/c.test.js');
});

test('a test that flips between runs is listed, with its result per run', () => {
  const runs = [
    run('ubuntu-latest', 'node', 1, nodeJunit('test/timing.test.js', [['budget holds', 'pass'], ['always red', 'fail']])),
    run('ubuntu-latest', 'node', 2, nodeJunit('test/timing.test.js', [['budget holds', 'fail'], ['always red', 'fail']])),
    run('ubuntu-latest', 'node', 3, nodeJunit('test/timing.test.js', [['budget holds', 'pass'], ['always red', 'fail']])),
  ];
  const report = buildReport(runs, { expectedRuns: 3 });
  assert.equal(report.flaky.length, 1);
  const [t] = report.flaky;
  assert.equal(t.file, 'test/timing.test.js');
  assert.equal(t.name, 'budget holds');
  assert.equal(t.os, 'ubuntu-latest');
  assert.deepEqual(t.byRun, { 1: 'pass', 2: 'fail', 3: 'pass' });
  assert.deepEqual(
    report.always_failing.map((x) => x.name),
    ['always red'],
  );
});

test('stable tests are not listed, and a skip next to a pass is not a flip', () => {
  const runs = [1, 2, 3].flatMap((n) => [
    run('ubuntu-latest', 'node', n, nodeJunit('test/stable.test.js', [['always green', 'pass'], ['skipped once', n === 1 ? 'skip' : 'pass']])),
    run('windows-latest', 'python', n, pytestJunit([['tests/test_stable.py', 'test_green', 'pass']])),
  ]);
  const report = buildReport(runs, { expectedRuns: 3 });
  assert.deepEqual(report.flaky, []);
  assert.deepEqual(report.always_failing, []);
  assert.equal(renderMarkdown(report).includes('No test changed its result between runs.'), true);
});

test('a flip on one operating system is listed for that operating system only', () => {
  const runs = [
    run('ubuntu-latest', 'python', 1, pytestJunit([['tests/test_x.py', 'test_race', 'pass']])),
    run('ubuntu-latest', 'python', 2, pytestJunit([['tests/test_x.py', 'test_race', 'fail']])),
    run('windows-latest', 'python', 1, pytestJunit([['tests/test_x.py', 'test_race', 'pass']])),
    run('windows-latest', 'python', 2, pytestJunit([['tests/test_x.py', 'test_race', 'pass']])),
  ];
  const report = buildReport(runs, { expectedRuns: 2 });
  assert.equal(report.flaky.length, 1);
  assert.equal(report.flaky[0].os, 'ubuntu-latest');
  assert.equal(report.flaky[0].file, 'tests/test_x.py');
});

test('a test missing from one run is not flaky by itself, and the run count is reported', () => {
  const runs = [
    run('ubuntu-latest', 'node', 1, nodeJunit('test/a.test.js', [['only once', 'pass']])),
    run('ubuntu-latest', 'node', 2, nodeJunit('test/a.test.js', [])),
    run('ubuntu-latest', 'node', 3, nodeJunit('test/a.test.js', [['only once', 'pass']])),
  ];
  const report = buildReport(runs, { expectedRuns: 3 });
  assert.deepEqual(report.flaky, []);
  assert.ok(report.warnings.some((w) => w.includes('no test case could be read')));
  const short = buildReport(runs.slice(0, 1), { expectedRuns: 3 });
  assert.ok(short.warnings.some((w) => w.includes('1 of 3 runs were read')));
});

test('repeated names inside one run keep their own identity', () => {
  const twice = nodeJunit('test/dup.test.js', [
    ['same name', 'pass'],
    ['same name', 'fail'],
  ]);
  const runs = [run('ubuntu-latest', 'node', 1, twice), run('ubuntu-latest', 'node', 2, twice)];
  const report = buildReport(runs, { expectedRuns: 2 });
  assert.deepEqual(report.flaky, []);
  assert.equal(report.always_failing.length, 1);
  assert.equal(report.always_failing[0].name, 'same name (#2)');
});

test('markdown has the summary table, the flaky table and escaped cells', () => {
  const runs = [
    run('ubuntu-latest', 'node', 1, nodeJunit('test/p.test.js', [['a | b &lt;c&gt;', 'pass']])),
    run('ubuntu-latest', 'node', 2, nodeJunit('test/p.test.js', [['a | b &lt;c&gt;', 'fail']])),
  ];
  const md = renderMarkdown(buildReport(runs, { expectedRuns: 2 }));
  assert.match(md, /^# Flaky test report/);
  assert.match(md, /\| OS \| Suite \| Runs \| Tests \| Flaky \| Failing in every run \|/);
  assert.match(md, /\| ubuntu-latest \| node \| 1, 2 \| 1 \| 1 \| 0 \|/);
  assert.match(md, /\| OS \| Suite \| Test file \| Test name \| Run 1 \| Run 2 \|/);
  assert.match(md, /\| ubuntu-latest \| node \| test\/p\.test\.js \| a \\\| b &lt;c&gt; \| pass \| fail \|/);
});

test('buildReport refuses the same run twice', () => {
  const runs = [run('ubuntu-latest', 'node', 1, nodeJunit('test/a.test.js', [])), run('ubuntu-latest', 'node', 1, nodeJunit('test/a.test.js', []))];
  assert.throws(() => buildReport(runs), /given twice/);
});

test('main reads run files from folders, writes both reports and fails on an empty folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-report-'));
  try {
    const input = path.join(root, 'in');
    const sub = path.join(input, 'junit-ubuntu-latest-node');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'ubuntu-latest--node--run1.xml'), nodeJunit('test/t.test.js', [['flip', 'pass']]));
    fs.writeFileSync(path.join(sub, 'ubuntu-latest--node--run2.xml'), nodeJunit('test/t.test.js', [['flip', 'fail']]));
    fs.writeFileSync(path.join(sub, 'notes.xml'), '<x/>');
    const out = path.join(root, 'out');
    const quiet = { log: () => {}, error: () => {} };
    assert.equal(main(['--in', input, '--out', out, '--expected-runs', '2'], quiet), 0);
    const json = JSON.parse(fs.readFileSync(path.join(out, 'flaky-report.json'), 'utf8'));
    assert.equal(json.flaky.length, 1);
    assert.ok(json.warnings.some((w) => w.includes('notes.xml')));
    assert.ok(fs.readFileSync(path.join(out, 'flaky-report.md'), 'utf8').includes('| flip |'));

    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    assert.equal(main(['--in', empty, '--out', out], quiet), 1);
    assert.equal(main(['--out', out], quiet), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
