'use strict';

// Glob matching takes time linear in the path for each pattern token, whatever
// the number of "*", and it matches what the previous regular expression matched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');
const exe = require('../lib/exe');
const os = require('os');
const path = require('path');
const { budget, cpuNow, cpuMsSince } = require('./helpers/time_budget');

// Real absolute paths for the platform: a POSIX-style home such as '/home/u' is not
// absolute on Windows, so "~/..." would not resolve to a credential file there.
const HOME = path.join(os.tmpdir(), 'zn-glob-home');
const OPTS = { cwd: path.join(HOME, 'project'), home: HOME, env: {} };

// The previous implementation, kept here as the reference for short inputs.
function reference(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const PATHS = ['/home/u/.aws/credentials', '/home/u/.ssh/id_rsa', '/home/u/project/.env', '/home/u/project/.env.local',
  '/home/u/.config/gcloud/credentials.db', '/home/u/a/b/c', '/home/u/.netrc', '', 'abc', 'a/b'];

test('matches like the previous regular expression (no bracket expressions)', () => {
  const alphabet = ['*', '?', 'a', 'e', 'n', 'v', '.', '/', 's', 'h', 'c'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 4000; k++) {
    let g = rnd(2) ? '/home/u/' : '';
    const len = 1 + rnd(12);
    for (let j = 0; j < len; j++) g += alphabet[rnd(alphabet.length)];
    const ref = reference(g);
    const now = policy.globRegExp(g);
    for (const p of PATHS) assert.equal(now.test(p), ref.test(p), JSON.stringify([g, p]));
  }
});

test('many "*" never make the match slow', () => {
  const n = 50000;
  const words = ['*'.repeat(n) + 'b', '*'.repeat(n) + '/x', '*a'.repeat(n / 2) + 'b', '*a*a*b'.repeat(n / 6),
    '*'.repeat(n) + '/.env*', '?*'.repeat(n / 2) + 'z', '[a-z]*'.repeat(n / 6) + '!'];
  const targets = ['/home/u/.aws/credentials', '/home/u/project/' + 'a'.repeat(200), 'a'.repeat(255)];
  for (const w of words) {
    const m = policy.globRegExp(w);
    const t0 = cpuNow();
    for (const t of targets) m.test(t);
    const ms = cpuMsSince(t0);
    assert.ok(ms < budget(1000), w.slice(0, 12) + '... took ' + ms.toFixed(1) + ' ms');
  }
});

test("a very long glob word is handled quickly", () => {
  const t0 = cpuNow();
  policy.classifyWord('*a'.repeat(30000) + 'b', OPTS);
  const ms = cpuMsSince(t0);
  assert.ok(ms < budget(1000), 'took ' + ms.toFixed(1) + ' ms');
});

test('a bash command with a long glob is checked quickly, and still denied when it names a credential file', () => {
  const opts = OPTS;
  const t0 = cpuNow();
  policy.bashDenial('cat ' + '*'.repeat(20000) + 'a*a*a*b', opts);
  const deny = policy.bashDenial('cat ~/' + '*'.repeat(20000) + '/credentials', opts);
  const ms = cpuMsSince(t0);
  assert.ok(deny, 'a glob that names ~/.aws/credentials is denied');
  assert.ok(ms < budget(1500), 'took ' + ms.toFixed(1) + ' ms');
});

test('the program name of a very long command word is read fast, and short ones as before', () => {
  const t0 = cpuNow();
  exe.interpreterBase('python' + '1'.repeat(50000) + ' x.py');
  exe.interpreterBase('node' + '-1'.repeat(25000) + ' x.js');
  const ms = cpuMsSince(t0);
  assert.ok(ms < budget(100), 'took ' + ms.toFixed(1) + ' ms');
  assert.equal(exe.interpreterBase('python3.12m script.py'), 'python');
  assert.equal(exe.interpreterBase('/usr/bin/node22 a.js'), 'node');
  assert.equal(exe.interpreterBase('C:\\Python\\pythonw.exe a.py'), 'pythonw');
});

// --- bracket expressions, long paths and long legitimate commands ---

const files = require('../lib/broker/files');

// The previous implementation with bracket expressions, for short inputs.
function referenceFull(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const end = c === '[' ? policy._globClassEnd(pattern, i) : -1;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (end !== -1) {
      re += policy._globClassSource(pattern.slice(i + 1, end));
      i = end;
    } else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

test('matches like the previous regular expression, with bracket expressions', () => {
  const parts = ['*', '?', 'a', 'e', 'n', 'v', '.', '/', '[a-e]', '[!a]', '[^.]', '[]x]', '[[:alpha:]]', '[[:nope:]]', '[z-a]', '[', ']', '\\'];
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 4000; k++) {
    let g = rnd(2) ? '/home/u/' : '';
    const len = 1 + rnd(8);
    for (let j = 0; j < len; j++) g += parts[rnd(parts.length)];
    const ref = referenceFull(g);
    const now = policy.globRegExp(g);
    for (const p of PATHS.concat(['/home/u/.env', 'x]', 'a.e', '!', 'a\\'])) {
      // A bracket expression never matches "/" now, as in the shell; skip the cases where only that differs.
      if (p.includes('/') && /\[[^\]]*\]/.test(g) && ref.test(p) && !now.test(p)) continue;
      assert.equal(now.test(p), ref.test(p), JSON.stringify([g, p]));
    }
  }
});

test('a bracket expression never matches a separator', () => {
  assert.equal(policy.globRegExp('x[/]y').test('x/y'), false);
  assert.equal(policy.globRegExp('x[!a]y').test('x/y'), false);
});

test('a very long path is classified quickly', () => {
  const opts = OPTS;
  for (const w of ['a/'.repeat(25000) + 'x', '*/'.repeat(25000) + 'x', '/home/u/' + 'b/'.repeat(25000) + '.env']) {
    const t0 = cpuNow();
    policy.classifyWord(w, opts);
    policy.bashDenial('cat ' + w, opts);
    files.realTargetOf(w);
    const ms = cpuMsSince(t0);
    assert.ok(ms < budget(2000), w.slice(0, 10) + '... took ' + ms.toFixed(1) + ' ms');
  }
});

test('long legitimate commands with "?" are not refused', () => {
  const opts = OPTS;
  const text = 'Why does this fail? '.repeat(250);
  for (const cmd of ['git commit -m "' + text + '"', "printf '%s' '" + text + "' > notes.txt", "curl 'https://example.com/?q=" + 'x'.repeat(5000) + "'"]) {
    const t0 = cpuNow();
    const deny = policy.bashDenial(cmd, opts);
    const ms = cpuMsSince(t0);
    assert.equal(deny, null, cmd.slice(0, 30));
    assert.ok(ms < budget(1500), cmd.slice(0, 20) + '... took ' + ms.toFixed(1) + ' ms');
  }
});

test('a word with very many "[" is refused quickly', () => {
  const t0 = cpuNow();
  const c = policy.classifyWord('['.repeat(50000), OPTS);
  const ms = cpuMsSince(t0);
  assert.equal(c && c.kind, 'credential');
  assert.ok(ms < budget(1000), 'took ' + ms.toFixed(1) + ' ms');
});

test('realTargetOf keeps its result for existing and missing paths', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-rt-')));
  try {
    fs.mkdirSync(path.join(d, 'real'));
    try { fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link')); } catch (_) { return; }
    assert.equal(files.realTargetOf(path.join(d, 'link', 'a', 'b')), path.join(d, 'real', 'a', 'b'));
    assert.equal(files.realTargetOf(path.join(d, 'real')), path.join(d, 'real'));
    assert.equal(files.realTargetOf(path.join(d, 'nope', 'x')), path.join(d, 'nope', 'x'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('bracket expressions are scanned once per pattern', () => {
  const opts = OPTS;
  const braces = '{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}';
  const words = ['[:'.repeat(1000) + 'a'.repeat(48000), braces + '[:'.repeat(300) + 'a'.repeat(20000),
    braces + '[:'.repeat(990) + 'a'.repeat(48000), '[' + '[:'.repeat(20000) + ']', '[!' + ':]['.repeat(15000)];
  for (const w of words) {
    const t0 = cpuNow();
    policy.classifyWord(w, opts);
    policy.bashDenial('cat ' + w, opts);
    const ms = cpuMsSince(t0);
    assert.ok(ms < budget(2000), w.slice(0, 12) + '... took ' + ms.toFixed(1) + ' ms');
  }
});

test('the class end table gives the same answers as a direct scan', () => {
  const direct = (pattern, open) => {
    let k = open + 1;
    if (pattern[k] === '!' || pattern[k] === '^') k++;
    if (pattern[k] === ']') k++;
    while (k < pattern.length) {
      if (pattern.startsWith('[:', k)) {
        const end = pattern.indexOf(':]', k + 2);
        if (end !== -1) { k = end + 2; continue; }
      }
      if (pattern[k] === ']') return k;
      k++;
    }
    return -1;
  };
  const parts = ['[', ']', ':', '[:', ':]', '!', '^', 'a', '-'];
  let seed = 5;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 5000; k++) {
    let g = '';
    const len = 1 + rnd(10);
    for (let j = 0; j < len; j++) g += parts[rnd(parts.length)];
    for (let i = 0; i < g.length; i++) if (g[i] === '[') assert.equal(policy._globClassEnd(g, i), direct(g, i), JSON.stringify([g, i]));
  }
});

test('brace patterns are read without backtracking, and very large ones are refused quickly', () => {
  const opts = OPTS;
  const braces = '{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}';
  const cases = [['{' + ','.repeat(50000), 500], ['{' + ','.repeat(50000) + '}', 500], [braces + '*/'.repeat(100000) + 'x', 2000]];
  for (const [w, limit] of cases) {
    const t0 = cpuNow();
    policy.classifyWord(w, opts);
    policy.bashDenial('cat ' + w, opts);
    const ms = cpuMsSince(t0);
    assert.ok(ms < budget(limit), w.slice(0, 12) + '... took ' + ms.toFixed(1) + ' ms');
  }
  const big = policy.classifyWord(braces + '*/'.repeat(100000) + 'x', opts);
  assert.equal(big && big.kind, 'credential');
  // Ordinary brace patterns still expand and match as before.
  assert.ok(policy.classifyWord('~/.aws/{config,credentials}', opts));
  assert.ok(policy.classifyWord('~/.ssh/id_{rsa,ed25519}', opts));
});
