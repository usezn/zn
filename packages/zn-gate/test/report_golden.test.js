'use strict';
// Golden text: the plain report for one fixed fake stats file, NO_COLOR set and 80 columns,
// compared line by line with a stored expected file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-report-golden-'));
process.env.ZN_HOME = home;
process.env.NO_COLOR = '1';
process.env.COLUMNS = '80';
delete process.env.ZN_STATS;

const report = require('../lib/report');

const FIXTURES = path.join(__dirname, 'fixtures', 'report_golden');
const NOW = new Date('2026-10-17T12:00:00Z');
// A Windows checkout may turn the stored text into CRLF lines; the report itself always writes LF.
const expectedLines = () => fs.readFileSync(path.join(FIXTURES, 'expected.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('the plain report for a fixed stats file matches the stored text line by line', () => {
  fs.copyFileSync(path.join(FIXTURES, 'stats.json'), path.join(home, 'stats.json'));
  let out = '';
  const code = report.run([], (s) => { out += s; }, { now: NOW });
  assert.equal(code, 0);
  assert.ok(!out.includes('\u001b'), 'no color codes with NO_COLOR set');
  const got = out.split('\n');
  const want = expectedLines();
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    assert.equal(got[i], want[i], `line ${i + 1} differs`);
  }
});

test('the report without the closing team line matches the stored text minus that line', () => {
  fs.copyFileSync(path.join(FIXTURES, 'stats.json'), path.join(home, 'stats.json'));
  let out = '';
  report.run(['--no-team-line'], (s) => { out += s; }, { now: NOW });
  const want = expectedLines().filter((l) => !l.startsWith('Teams can see'));
  assert.deepEqual(out.split('\n'), want);
});
