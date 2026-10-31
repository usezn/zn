'use strict';
// Direct edge-case tests for findPromptAssignments (lib/scrub/prompt.js).
// Every value below is an obviously fake string assembled at runtime.
const test = require('node:test');
const assert = require('node:assert');
const { findPromptAssignments } = require('../lib/scrub/prompt');
const { budget } = require('./helpers/time_budget');

const V = ['q7w8', 'e9r0', 't1y2', 'Zx'].join('');   // 14 chars, not a placeholder
const names = (t) => findPromptAssignments(t).map((r) => r.name);
const values = (t) => findPromptAssignments(t).map((r) => t.slice(r.start, r.end));
const flagged = (t) => findPromptAssignments(t).length > 0;

test('names: only identifier-like names count', () => {
  assert.deepEqual(names('API_KEY=' + V), ['API_KEY']);
  assert.deepEqual(names('my-api-key=' + V), ['MY_API_KEY']);
  assert.deepEqual(names('apiKey=' + V), ['API_KEY']);
  assert.deepEqual(names('APIKEY=' + V), ['APIKEY']);
  assert.deepEqual(names('secret_key_base=' + V), ['SECRET_KEY_BASE']);
  // not identifiers, or a reference to something else
  assert.ok(!flagged('1API_KEY=' + V), 'leading digit');
  assert.ok(!flagged('A=' + V), 'one-letter name');
  assert.ok(!flagged('$API_KEY=' + V), 'shell variable');
  assert.ok(!flagged('x.API_KEY=' + V), 'attribute access');
  assert.ok(!flagged('api.key=' + V), 'dotted name');
  assert.ok(!flagged('API_KEY==' + V), 'comparison');
  assert.ok(!flagged('API_KEY => ' + V), 'arrow');
  assert.ok(!flagged('API_KEY -> ' + V), 'arrow');
  assert.ok(!flagged('[API_KEY, ' + V + ']'), 'list');
});

test('names: non-ASCII names are not recognised', () => {
  assert.ok(!flagged('ПАРОЛЬ=' + V));
  assert.ok(!flagged('contraseña=' + V));
});

test('quotes: single, double and JSON-style quoting give the bare value', () => {
  assert.deepEqual(values('API_KEY="' + V + '"'), [V]);
  assert.deepEqual(values("API_KEY='" + V + "'"), [V]);
  assert.deepEqual(values('"API_KEY"="' + V + '"'), [V]);
  assert.deepEqual(values("'API_KEY'='" + V + "'"), [V]);
  assert.deepEqual(values("'api_key': '" + V + "'"), [V]);
  assert.deepEqual(values('{"api_key": "' + V + '"}'), [V]);
  assert.deepEqual(values('API_KEY = "' + V + '"'), [V]);
  // unterminated quote: the value is still taken
  assert.deepEqual(values('API_KEY="' + V), [V]);
  // a trailing stray quote is not part of the value
  assert.deepEqual(values('API_KEY=' + V + '"'), [V]);
});

test('inline code: backticks around the whole assignment do not hide it', () => {
  assert.deepEqual(values('set `API_KEY=' + V + '` first'), [V]);
});

test('lines: LF, CRLF and surrounding lines', () => {
  assert.deepEqual(values('a\nAPI_KEY=' + V + '\nb'), [V]);
  assert.deepEqual(values('a\r\nAPI_KEY=' + V + '\r\nb'), [V]);
  assert.deepEqual(values('API_KEY=' + V + '\r\n'), [V]);
  const two = 'API_KEY=' + V + '\r\nDB_PASSWORD=' + V + 'x\r\n';
  assert.deepEqual(names(two), ['API_KEY', 'DB_PASSWORD']);
  assert.deepEqual(values(two), [V, V + 'x']);
});

test('lines: the value must be on the same line as the name', () => {
  assert.ok(!flagged('API_KEY=\n' + V));
  assert.ok(!flagged('API_KEY:\n' + V));
  assert.ok(!flagged('API_KEY =\n' + V));
});

test('offsets: start and end point at the value, also after multi-byte text', () => {
  const t = 'éè 日本\n\r\nuse API_KEY=' + V + ' now';
  const r = findPromptAssignments(t);
  assert.equal(r.length, 1);
  assert.equal(t.slice(r[0].start, r[0].end), V);
  assert.equal(r[0].type, 'CREDENTIAL');
  assert.equal(r[0].source, 'pattern');
});

test('code fences and prose: a fence does not make an assignment safe', () => {
  assert.deepEqual(values('```\nAPI_KEY=' + V + '\n```'), [V]);
  assert.deepEqual(values('```sh\nexport API_KEY=' + V + '\n```'), [V]);
  assert.deepEqual(values('The api key is API_KEY=' + V + ' ok'), [V]);
  assert.deepEqual(values('(API_KEY=' + V + ')'), [V]);
  assert.deepEqual(values('API_KEY=' + V + '.'), [V]);
  assert.deepEqual(values('API_KEY=' + V + ','), [V]);
});

test('prefixes: export, set, $env: and cmd forms', () => {
  assert.deepEqual(values('export API_KEY=' + V), [V]);
  assert.deepEqual(values('export API_KEY="' + V + '"'), [V]);
  assert.deepEqual(values('set API_KEY=' + V), [V]);
  assert.deepEqual(values('set "API_KEY=' + V + '"'), [V]);
  assert.deepEqual(values('set /p API_KEY=' + V), [V]);
  assert.deepEqual(values('$env:API_KEY="' + V + '"'), [V]);
  assert.deepEqual(values('$env:API_KEY = "' + V + '"'), [V]);
  assert.deepEqual(values("$env:API_KEY='" + V + "'"), [V]);
  assert.deepEqual(names('export API_KEY=' + V), ['API_KEY']);
});

test('separators: spaces and tabs around = and :', () => {
  assert.deepEqual(values('API_KEY = ' + V), [V]);
  assert.deepEqual(values('API_KEY : ' + V), [V]);
  assert.deepEqual(values('API_KEY\t=\t' + V), [V]);
  assert.deepEqual(values('api_key:' + V), [V]);
  assert.deepEqual(values('  api_key:    ' + V), [V]);
});

test('JSON and YAML key: value', () => {
  assert.deepEqual(values('{"api_key": "' + V + '"}'), [V]);
  assert.deepEqual(values('{"password":"' + V + '"}'), [V]);
  assert.deepEqual(values('api_key: ' + V), [V]);
  assert.deepEqual(values('api_key: "' + V + '"'), [V]);
  assert.deepEqual(values('- API_KEY: ' + V), [V]);
  assert.deepEqual(values('env:\n  API_KEY: ' + V), [V]);
  assert.deepEqual(values('{"token": "' + V + '"}'), [V]);
});

test('plain lowercase word names need = or a quoted key, not a bare colon', () => {
  assert.ok(flagged('token=' + V));
  assert.ok(flagged('password=' + V));
  assert.ok(flagged('"token": "' + V + '"'));
  assert.ok(!flagged('token: ' + V));
  assert.ok(!flagged('password: ' + V));
  assert.ok(!flagged('password is ' + V));
  // mixed case reads as a value, not as prose
  assert.ok(flagged('Password: Required123'));
});

test('references and vault markers are never flagged', () => {
  assert.ok(!flagged('API_KEY=__ZN_API_KEY__'));
  assert.ok(!flagged('API_KEY="__ZN_API_KEY__"'));
  assert.ok(!flagged('{"api_key": "__ZN_API_KEY__"}'));
  assert.ok(!flagged('API_KEY=prefix__ZN_API_KEY__suffix'));
  assert.ok(!flagged('API_KEY=${API_KEY}'));
  assert.ok(!flagged('API_KEY="${API_KEY}"'));
  assert.ok(!flagged('API_KEY=$API_KEY'));
  assert.ok(!flagged('API_KEY=%API_KEY%'));
  assert.ok(!flagged('$env:API_KEY=$env:OTHER_VALUE'));
  assert.ok(!flagged('API_KEY=process.env.API_KEY'));
  assert.ok(!flagged('API_KEY=os.environ.API_KEY'));
  assert.ok(!flagged('API_KEY=secrets.GITHUB_TOKEN'));
  assert.ok(!flagged('API_KEY=arn:aws:secretsmanager:us-east-1:123456789012:secret:x'));
});

test('empty and short values are not flagged', () => {
  assert.ok(!flagged('API_KEY='));
  assert.ok(!flagged('API_KEY=""'));
  assert.ok(!flagged("API_KEY=''"));
  assert.ok(!flagged('API_KEY= '));
  assert.ok(!flagged('API_KEY=short'));
  assert.ok(!flagged('API_KEY=1234567'));          // 7 characters
  assert.ok(flagged('API_KEY=q7w8e9r0'));          // 8 characters
});

test('elided values are not flagged', () => {
  assert.ok(!flagged('API_KEY=' + V + '...'));
  assert.ok(!flagged('API_KEY=' + V + '…'));
});

test('elided Bearer tokens are not flagged; a full one still is (B-1948)', () => {
  const tok = ['ab', 'c1', '23', 'q7w8e9r0'].join('');   // 14 chars, digits: a full token is masked
  assert.deepEqual(names('Authorization: Bearer ' + tok), ['AUTHORIZATION']);
  assert.deepEqual(values('Authorization: Bearer ' + tok + '.'), [tok]);
  assert.ok(!flagged('Authorization: Bearer ' + tok + '...'), 'three dots');
  assert.ok(!flagged('Authorization: Bearer ' + tok + '…'), 'ellipsis character');
  assert.ok(!flagged('Authorization: Bearer ' + tok + '...)'), 'three dots then punctuation');
  assert.ok(!flagged('Authorization: Bearer ' + tok + '….'), 'ellipsis then a full stop');
  assert.ok(!flagged('use "Authorization: Bearer abc123..." in the header'), 'example from the task');
});

test('Unicode values are not flagged; neighbouring ASCII ones still are', () => {
  assert.ok(!flagged('API_KEY=клюя1234secret'));
  assert.ok(!flagged('API_KEY=pässwörd12345'));
  assert.ok(!flagged('API_KEY=日本語のパスワード1234'));
  assert.ok(!flagged('API_KEY=​' + V), 'zero-width space before the value');
  assert.deepEqual(values('API_KEY=éé DB_PASSWORD=' + V), [V]);
});

test('prose: ordinary sentences are not flagged', () => {
  for (const t of [
    'the password is required',
    'key: value pairs',
    'password: required',
    'token: expired',
    'secret: abcdefghijkl',
    'Please enter your password: it must be long',
    'the api key: see the dashboard',
    'What is a secret? A token: an opaque string',
    'Password reset: check your email',
  ]) assert.ok(!flagged(t), t);
});

test('several assignments in one prompt are all reported, in order', () => {
  const t = 'API_KEY=' + V + ' DB_PASSWORD=' + V + 'x and TOKEN=' + V + 'y';
  assert.deepEqual(names(t), ['API_KEY', 'DB_PASSWORD', 'TOKEN']);
  assert.deepEqual(values(t), [V, V + 'x', V + 'y']);
});

test('a candidate hidden inside a rejected value is still found', () => {
  const t = 'URL=https://host.example.com/path?api_key=' + V;
  assert.deepEqual(values(t), [V]);
  assert.deepEqual(names(t), ['API_KEY']);
});

test('values: the maximum length and beyond', () => {
  const ok = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7';
  const long = ok.repeat(18);                       // 486 chars
  assert.deepEqual(values('API_KEY=' + long), [long]);
  // over 512 characters: still flagged (the prompt is blocked as a whole);
  // the span covers the first 512 characters
  const huge = ok.repeat(30);
  assert.equal(huge.length > 512, true);
  assert.deepEqual(values('API_KEY=' + huge), [huge.slice(0, 512)]);
});

test('input guards: non-strings and short strings', () => {
  assert.deepEqual(findPromptAssignments(undefined), []);
  assert.deepEqual(findPromptAssignments(null), []);
  assert.deepEqual(findPromptAssignments(42), []);
  assert.deepEqual(findPromptAssignments({}), []);
  assert.deepEqual(findPromptAssignments(''), []);
  assert.deepEqual(findPromptAssignments('A=b'), []);
});

test('is stateless across calls (global regex lastIndex)', () => {
  const t = 'API_KEY=' + V;
  for (let i = 0; i < 3; i++) assert.deepEqual(values(t), [V]);
  assert.deepEqual(findPromptAssignments('nothing here at all'), []);
  assert.deepEqual(values(t), [V]);
});

test('1 MiB prompts: linear time on adversarial shapes', () => {
  const N = 1024 * 1024;
  const shapes = {
    repeated_assignments: ('API_KEY=' + 'x'.repeat(30) + ' ').repeat(Math.floor(N / 39)),
    one_long_word: 'a'.repeat(N),
    name_repeated: 'API_KEY'.repeat(Math.floor(N / 7)),
    long_names: ('A_'.repeat(60) + ' ').repeat(Math.floor(N / 121)),
    quotes_only: '"'.repeat(N),
    spaced_separators: 'API_KEY = '.repeat(Math.floor(N / 10)),
    huge_value: 'API_KEY=' + 'y'.repeat(N),
    near_miss_names: ('a_b-'.repeat(32) + ':').repeat(Math.floor(N / 129)),
    values_over_cap: ('password=' + 'a'.repeat(600) + ' ').repeat(Math.floor(N / 610)),
    whitespace_around: ' '.repeat(N / 2) + 'API_KEY' + ' '.repeat(N / 2),
    tabs_after_name: ('API_KEY' + ' \t'.repeat(200)).repeat(Math.floor(N / 407)),
  };
  for (const [label, text] of Object.entries(shapes)) {
    const t0 = process.hrtime.bigint();
    findPromptAssignments(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < budget(3000), label + ' took ' + ms.toFixed(0) + ' ms');
  }
});

test('1 MiB prompts: only the first MiB is checked', () => {
  const pad = 'x '.repeat(512 * 1024);               // exactly 1 MiB
  assert.equal(pad.length, 1024 * 1024);
  assert.deepEqual(findPromptAssignments(pad + 'API_KEY=' + V), []);
  const head = findPromptAssignments('API_KEY=' + V + '\n' + pad);
  assert.equal(head.length, 1);
});

test('forms that stay out: a value split by a space, a YAML tag', () => {
  assert.ok(!flagged('API_KEY=' + V.slice(0, 4) + ' ' + V.slice(4)), 'split by a space');
  assert.ok(!flagged('API_KEY: !!str ' + V));
});
