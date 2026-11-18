'use strict';

process.env.ZN_STATS = 'off';

// Patterns that were quadratic (or worse) on their own at 10 to 100 KiB, whether or not a hook entry point reached them.
// Each one is now linear, or is not run past a fixed size. The inputs are the worst shapes found for each; the sizes double
// and the time may grow by a generous factor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../lib/hooks/policy');
const destructive = require('../lib/destructive');
const exe = require('../lib/exe');
const { cmdQuote } = require('../lib/broker/run');
const audit = require('../lib/audit');

function cpuMs(f) {
  const s = process.cpuUsage();
  f();
  const d = process.cpuUsage(s);
  return (d.user + d.system) / 1000;
}

// Time f(input) at 16, 32, 64 and 128 KiB; the last must be within 40 times the first (8 times more input costs about 8 times
// for a linear check and 64 times for a quadratic one) and under a hard limit; the first is floored at 5 ms so timer noise does not decide.
const SIZES = [16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024];
const HARD_MS = 3000;
function grows(name, make, f) {
  const times = SIZES.map((n) => { const input = make(n); return cpuMs(() => f(input)); });
  const first = Math.max(times[0], 5);
  const last = times[times.length - 1];
  assert.ok(last < HARD_MS, name + ' took ' + Math.round(last) + ' ms at 128 KiB');
  assert.ok(last / first < 40, name + ' grows too fast: ' + times.map((t) => Math.round(t)).join(' / ') + ' ms');
}
const rep = (unit) => (n) => unit.repeat(Math.ceil(n / unit.length));

test('xargs followed by a zn audit stays linear', () => {
  const run = (t) => policy._xargsRunsZnAudit(t);
  grows('xargs, spaces', (n) => 'xargs ' + ' '.repeat(n), run);
  grows('xargs, repeated', rep('xargs a '), run);
  grows('xargs, parts', rep('xargs;'), run);
  grows('xargs, specs', (n) => 'xargs ' + '/zn-gate@'.repeat(Math.ceil(n / 9)), run);
  grows('xargs, specs and spaces', (n) => 'xargs ' + ' zn-gate@x'.repeat(Math.ceil(n / 10)), run);
  grows('xargs, through adminCommand', (n) => 'xargs ' + ' '.repeat(n), (t) => policy.adminCommand(t));
});

test('xargs followed by a zn audit keeps its meaning', () => {
  assert.equal(policy.adminCommand('ls | xargs zn audit'), 'audit --approve');
  assert.equal(policy.adminCommand('ls | xargs -n1 npx zn-gate@1.2.3 -- audit'), 'audit --approve');
  assert.equal(policy.adminCommand('xargs a\nzn audit'), 'audit --approve');
  assert.equal(policy.adminCommand('xargs a; zn audit'), null);
  assert.equal(policy.adminCommand('xargs zn status'), null);
  assert.equal(policy.adminCommand('xargs xargs xargs /zn-gate@1 audit'), 'audit --approve');
});

test('the cmd.exe context check is not run past its size cap and stays fast under it', () => {
  if (process.platform === 'win32') return;
  assert.equal(policy._cmdContext('echo ^ plain'), false);
  assert.equal(policy._cmdContext('cmd /c echo ^&'), true);
  assert.equal(policy._cmdContext('./run.bat ^'), true);
  grows('cmd context, over the cap', (n) => 'cmd ' + '||'.repeat(n / 2), (t) => policy._cmdContext(t));
  grows('cmd context, no cmd word', (n) => '||'.repeat(n / 2), (t) => policy._cmdContext(t));
  // Under the cap the pattern still runs; its worst case there is a small fraction of a second.
  const ms = cpuMs(() => policy._cmdContext('||'.repeat(4000) + 'cmdx'));
  assert.ok(ms < 1500, 'under the cap took ' + Math.round(ms) + ' ms');
  // Over the cap the text is read as cmd input.
  assert.equal(policy._cmdContext('echo ' + 'a'.repeat(9000) + ' cmd'), true);
});

test('bracket sets in a wildcard piece stay linear', () => {
  assert.equal(policy._bracketSetsToX('a[bc]d[e'), 'axd[e');
  assert.equal(policy._bracketSetsToX('[[a]]'), 'x]');
  assert.equal(policy._bracketSetsToX('[]'), 'x');
  grows('bracket run', rep('['), (t) => policy._bracketSetsToX(t));
  grows('bracket pairs', rep('[a'), (t) => policy._bracketSetsToX(t));
  grows('brackets with a late close', (n) => '['.repeat(n) + ']', (t) => policy._bracketSetsToX(t));
});

test('URLs in a text are found in linear time', () => {
  const texts = (t) => policy._egressUrlMatches(t).map((u) => u.text);
  assert.deepEqual(texts('see https://a.example/x?y=1) and ftp://h.example.'), ['https://a.example/x?y=1', 'ftp://h.example.']);
  assert.deepEqual(texts('x://'), []);
  grows('scheme-like dots', rep('a.'), texts);
  grows('scheme-like letters', rep('a'), texts);
  grows('scheme-like plus signs', rep('a+'), texts);
  grows('many separators', rep('://'), texts);
  grows('many short URLs', rep('a://b '), texts);
});

test('cmdQuote stays linear and keeps its output', () => {
  assert.equal(cmdQuote('a b'), '"a b"');
  assert.equal(cmdQuote('a"b'), '"a""b"');
  assert.equal(cmdQuote('x\\'), '"x\\\\"');
  assert.equal(cmdQuote('x\\"y'), '"x\\\\""y"');
  grows('backslash run', rep('\\'), cmdQuote);
  grows('backslash run then a letter', (n) => '\\'.repeat(n) + 'x', cmdQuote);
  grows('backslash pairs', rep('\\\\'), cmdQuote);
});

test('the quoted-string scan of a destructive check and the program-name suffix are capped', () => {
  // destructive.js does not read quoted strings past QUOTE_SCAN_MAX characters; exe.js skips names over 255 characters.
  grows('quoted strings', rep('\\"'), (t) => destructive.checkCommand('echo ' + t));
  grows('program name', rep('0-'), (t) => exe.isInterpreter(t));
});

function auditAt(root, rel) {
  return audit.auditFileAt({ root, rel }).findings.length;
}

test('zn audit stays fast on a file whose one line is long and hostile', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'latent-regex-'));
  try {
    const shapes = {
      'spaces after a label': (n) => 'bad' + ' '.repeat(n),
      'spaces after echo': (n) => 'echo ' + ' '.repeat(n),
      dashes: rep('-'),
      equals: rep('='),
      commas: rep(','),
      'warning phrases': rep('never follow untrusted '),
      'system tags': rep('<system'),
      'system tag then spaces': (n) => '<system>' + ' '.repeat(n),
      'scheme dots': rep('a.'),
      urls: rep('http://'),
      'quote and backslash': rep('\\"'),
      'allowed tools': (n) => 'allowed-tools: ' + ','.repeat(n),
    };
    const files = {
      'CLAUDE.md': (s) => s,
      '.claude/commands/x.md': (s) => '---\nallowed-tools: Bash\n---\n' + s,
      '.opencode/plugins/p.js': (s) => s,
    };
    for (const [rel, wrap] of Object.entries(files)) {
      for (const [name, make] of Object.entries(shapes)) {
        grows(rel + ' ' + name, make, (s) => {
          const abs = path.join(root, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, wrap(s) + '\n');
          auditAt(root, rel);
        });
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
