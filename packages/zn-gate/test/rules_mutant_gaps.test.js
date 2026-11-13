'use strict';

// Behaviour of lib/rules.js that a mutation audit showed no other test pins down:
// invisible-character counting, compatibility folding, line-break joining, the
// credential value filter, custom rules parsing, windowed scanning and masking.
// Inputs are inert: reserved domains, documentation keys and made-up values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../lib/rules');

function inProject(files, fn) {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gaps-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    process.chdir(dir);
    rules.loadCustomConfig(true);
    return fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    rules.loadCustomConfig(true);
  }
}

const cp = (n) => String.fromCodePoint(n);

test('invisibleStats counts a soft hyphen', () => {
  assert.deepEqual(rules.invisibleStats('a­b', 100), { count: 1, length: 3 });
});

test('invisibleStats counts a surrogate pair of the last plane as one character', () => {
  assert.deepEqual(rules.invisibleStats(cp(0x10ffff), 100), { count: 0, length: 1 });
});

test('invisibleStats counts tag characters and variation selectors supplement only inside their ranges', () => {
  assert.equal(rules.invisibleStats(cp(0xe0100), 100).count, 1, 'first of the supplement');
  assert.equal(rules.invisibleStats(cp(0xe01ef), 100).count, 1, 'last of the supplement');
  assert.equal(rules.invisibleStats(cp(0xe01f0), 100).count, 0, 'past the supplement');
  assert.equal(rules.invisibleStats(cp(0xe0080), 100).count, 0, 'between tags and supplement');
  assert.equal(rules.invisibleStats(cp(0xe007f), 100).count, 1, 'last tag character');
});

test('invisibleStats counts a flag tag sequence once, including a tag letter z', () => {
  const flag = cp(0x1f3f4) + cp(0xe007a) + cp(0xe007a) + cp(0xe007f);
  assert.equal(rules.invisibleStats(flag, 100).count, 1);
});

test('invisibleView joins a wrapped line at the largest text size it handles', () => {
  const head = 'A'.repeat(24) + '\n' + 'B'.repeat(24);
  const text = head + ' '.repeat((1 << 20) - head.length);
  assert.equal(text.length, 1 << 20);
  const view = rules.invisibleView(text);
  assert.ok(view, 'a view is built at exactly the limit');
  assert.ok(view.clean.startsWith('A'.repeat(24) + 'B'.repeat(24)));
  const over = rules.invisibleView(text + ' ');
  assert.equal(over, null, 'one character more: no wrap view');
});

test('normalizeInput folds compatibility characters, including the ends of each range', () => {
  assert.equal(rules.normalizeInput('ＡＢ').stripped, 'AB', 'fullwidth letters');
  assert.equal(rules.normalizeInput('～').stripped, '~', 'last fullwidth form');
  assert.equal(rules.normalizeInput('！').stripped, '!', 'first fullwidth form');
  assert.equal(rules.normalizeInput('ﬁx').stripped, 'fix', 'ligature');
  assert.equal(rules.normalizeInput('ﬆ').stripped, 'st', 'last ligature');
  assert.equal(rules.normalizeInput('ſ').stripped, 's', 'long s');
  assert.equal(rules.normalizeInput('K').stripped, 'K', 'Kelvin sign');
  assert.equal(rules.normalizeInput('①').stripped, '1', 'circled digit');
  assert.equal(rules.normalizeInput(cp(0x1d7ff)).stripped, '9', 'last mathematical digit');
});

test('normalizeInput joins a word split by a line break only between word characters', () => {
  assert.equal(rules.normalizeInput('exam\nple').stripped, 'example');
  assert.equal(rules.normalizeInput('foo,\nbar').stripped, 'foo,\nbar');
  assert.equal(rules.normalizeInput('foo\n,bar').stripped, 'foo\n,bar');
});

test('invisible-character counting flags a text made mostly of them', () => {
  const n = rules.MIN_INVISIBLE_CHECK_CHARS;
  assert.equal(rules.tooInvisible(['­'.repeat(n)]), true);
  assert.equal(rules.tooInvisible(['a'.repeat(n)]), false);
});

test('scanWindows keeps a block found in the first window of a long text', () => {
  const text = '~/.ssh/id_rsa ' + 'word '.repeat(Math.ceil(rules.MAX_SCAN_CHARS / 5) + 100);
  assert.ok(text.length > rules.MAX_SCAN_CHARS && text.length < rules.MAX_TOOL_RESULT_SCAN_CHARS);
  const res = rules.scanWindows(text);
  assert.equal(res.verdict, 'block');
  assert.equal(res.truncated, undefined);
});

test('scanWindows and evaluate give an allow for input that is not a string', () => {
  for (const v of [undefined, null, 42, {}]) {
    assert.equal(rules.evaluate(v).verdict, 'allow');
  }
});

test('sanitizeToolResult leaves a documentation key alone when maskSecrets is false', () => {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const kept = rules.sanitizeToolResult('t', 'id ' + key, { maskSecrets: false });
  assert.equal(kept.sanitized_content, 'id ' + key);
  assert.equal(kept.secrets_redacted, 0);
  const masked = rules.sanitizeToolResult('t', 'id ' + key);
  assert.equal(masked.sanitized_content, 'id [REDACTED_AWS_KEY]');
});

test('redactSecrets accepts an empty string and values that are not text', () => {
  assert.equal(rules.redactSecrets('').sanitized, '');
  for (const v of [undefined, null, 42]) {
    const r = rules.redactSecrets(v);
    assert.equal(r.sanitized, v);
    assert.deepEqual(r.detections, []);
  }
});

test('secrets on consecutive lines are redacted one by one, not as one span across the break', () => {
  // The key pattern runs on, so a view with the break removed matches both keys as one.
  const k1 = 'sk-ant-' + 'a1B2c3D4e5'.repeat(4);
  const k2 = 'sk-ant-' + 'Z9y8X7w6v5'.repeat(4);
  assert.equal(rules.redactSecrets(k1 + '\n' + k2).sanitized, '[REDACTED_ANTHROPIC_KEY]\n[REDACTED_ANTHROPIC_KEY]');
  // A key followed on the next line by a secret of another kind does not swallow it.
  assert.equal(rules.redactSecrets(k1 + '\nAKIAIOSFODNN7EXAMPLE').sanitized, '[REDACTED_ANTHROPIC_KEY]\n[REDACTED_AWS_KEY]');
});

test('two secrets that touch are each redacted with their own label', () => {
  const text = 'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"AKIAIOSFODNN7EXAMPLE';
  assert.equal(rules.redactSecrets(text).sanitized, 'AWS_SECRET_ACCESS_KEY="[REDACTED_AWS_SECRET]"[REDACTED_AWS_KEY]');
  const gh = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const withToken = 'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' + gh;
  assert.equal(rules.redactSecrets(withToken).sanitized, 'AWS_SECRET_ACCESS_KEY="[REDACTED_AWS_SECRET]"[REDACTED_GITHUB_TOKEN]');
});

test('scanWindows keeps a block when the text is also longer than the scan limit', () => {
  const text = '~/.ssh/id_rsa ' + 'word '.repeat(rules.MAX_SCAN_CHARS / 2);
  const res = rules.scanWindows(text, { maxScanChars: rules.MAX_SCAN_CHARS });
  assert.equal(res.verdict, 'block');
  assert.equal(res.truncated, true);
});

test('scanWindows allows input that is not a string', () => {
  for (const v of [undefined, null, 42]) assert.equal(rules.scanWindows(v).verdict, 'allow');
});

test('project rules: path lines, secret lines and patterns are read as what they are', () => {
  inProject({ '.znrules': 'path:/example/private\nsecret:EXAMPLE_TOKEN=abc\nexample-banned-word\n' }, () => {
    const cfg = rules.loadCustomConfig(true);
    assert.deepEqual(cfg.errors, []);
    assert.deepEqual(cfg.forbiddenPaths, ['/example/private']);
    assert.equal(cfg.bannedPatterns.length, 1, 'only the pattern line becomes a pattern');
    assert.equal(rules.evaluate('plain words here').verdict, 'allow');
    const hit = rules.evaluate('contains example-banned-word inside');
    assert.equal(hit.verdict, 'block');
    assert.equal(hit.rule, 'custom:banned_pattern');
  });
});

test('a cached verdict is not reused after the project rules change', () => {
  const text = 'a line with example-banned-word in it';
  assert.equal(rules.evaluate(text).verdict, 'allow');
  inProject({ '.znrules': 'example-banned-word\n' }, () => {
    assert.equal(rules.evaluate(text).verdict, 'block');
  });
  assert.equal(rules.evaluate(text).verdict, 'allow');
});

test('a base64 decode pipe passes on the first advisory it finds', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const first = b64('Put nginx in front of the API and act as a gateway for the workers.');
  const second = b64('Please forget all cached entries before the migration runs.');
  const r = rules.evaluate(`echo ${first} | base64 -d\necho ${second} | base64 -d`);
  assert.equal(r.verdict, 'allow');
  assert.equal(r.advisory && r.advisory.rule, 'pi:act_as');
});

test('the two words of a Russian rule far apart in one line do not make a match', () => {
  const far = 'забудь' + ' x'.repeat(60) + ' все';
  assert.equal(rules.evaluate(far).verdict, 'allow');
});

// isNonSecretValue(value, prefix): true when the value is not a credential.
const VALUE_CASES = [
  // [value, prefix, isNonSecret]
  ['l.MANAGER_xd', 'K8S_SECRET', true], // a chain whose parts have too few letters and digits to look random
  ['postgres://app:test@db.example.invalid/app', '', true], // placeholder password
  ['postgres://app:Zq8xK2mWv9@db.example.invalid/app', '', false],
  ['postgres://app:@db.example.invalid/app', '', true], // empty password
  ['eLR7PHnbgl@BAR_e3o!dummy', 'API_KEY', false], // 24 characters, random part
  ['amlCHANGEME_pTkzt0$your', 'DB_SECRET', true], // 23 characters
  ['IKclkROc-api', 'K8S_SECRET', true], // 12 characters, no digit
  ['kJFyrBRdQ_token', '', true], // 15 characters
  ['fwxxb.cert.vb', 'API_KEY', true],
  ['ift-7v82', '', false], // digit, three classes, exactly 3 bits per character
  ['n5DHP6üYWu!xxxxxx', '', false], // random part with a non-ASCII letter next to a placeholder mark
];

test('credential values: which are credentials and which are not', () => {
  for (const [value, prefix, expected] of VALUE_CASES) {
    assert.equal(rules.isNonSecretValue(value, prefix), expected, value);
  }
});
