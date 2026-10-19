'use strict';
// More ways of pasting a secret into a prompt: backticks, escaped JSON,
// quoted values with spaces or escaped quotes, setx and Authorization headers.
// Every value below is an obviously fake string assembled at runtime.
const test = require('node:test');
const assert = require('node:assert');
const { findPromptAssignments } = require('../lib/scrub/prompt');

const V = ['q7w8', 'e9r0', 't1y2', 'Zx'].join('');   // 14 chars, not a placeholder
const B = ['Zm9v', 'YmFy', 'Q2Fz', 'ZTEy', 'Mw=='].join('');   // base64-looking, 20 chars
const BS = '\\';
const Q = '"';
const names = (t) => findPromptAssignments(t).map((r) => r.name);
const values = (t) => findPromptAssignments(t).map((r) => t.slice(r.start, r.end));
const flagged = (t) => findPromptAssignments(t).length > 0;

test('backticks: a value in backticks is found', () => {
  assert.deepEqual(values('API_KEY=`' + V + '`'), [V]);
  assert.deepEqual(values('export API_KEY=`' + V + '`'), [V]);
  assert.deepEqual(values('"API_KEY": `' + V + '`'), [V]);
  assert.ok(!flagged('API_KEY=`${API_KEY}`'));
  assert.ok(!flagged('API_KEY=`<your-key>`'));
  assert.ok(!flagged('API_KEY=`YOUR_API_KEY`'));
});

test('escaped JSON from pasted logs is found', () => {
  const j1 = BS + Q + 'api_key' + BS + Q + ': ' + BS + Q + V + BS + Q;
  assert.deepEqual(values('{' + j1 + '}'), [V]);
  assert.deepEqual(names('{' + j1 + '}'), ['API_KEY']);
  assert.deepEqual(values('API_KEY=' + BS + Q + V + BS + Q), [V]);
  const j2 = BS + BS + Q + 'password' + BS + BS + Q + ':' + BS + BS + Q + V + BS + BS + Q;
  assert.deepEqual(values(j2), [V]);
  const ph = BS + Q + 'api_key' + BS + Q + ': ' + BS + Q + 'YOUR_API_KEY' + BS + Q;
  assert.ok(!flagged(ph));
  const vault = BS + Q + 'api_key' + BS + Q + ': ' + BS + Q + '__ZN_API_KEY__' + BS + Q;
  assert.ok(!flagged(vault));
});

test('quoted values with an escaped quote inside are taken whole', () => {
  const t = 'API_KEY="' + V + BS + Q + 'tail"';
  assert.deepEqual(values(t), [V + BS + Q + 'tail']);
  assert.deepEqual(values("API_KEY='" + V + BS + "'tail'"), [V + BS + "'tail"]);
});

test('quoted values with spaces', () => {
  assert.deepEqual(values('API_KEY="abc def ghijkl"'), ['abc def ghijkl']);
  assert.deepEqual(values('PASSWORD="correct horse battery"'), ['correct horse battery']);
  assert.deepEqual(values('"password": "hunter 2 and more"'), ['hunter 2 and more']);
  // prose after a colon, placeholders and references stay quiet
  assert.ok(!flagged('password: "must be long enough"'));
  assert.ok(!flagged('"password": "enter your password"'));
  assert.ok(!flagged('API_KEY="your api key here"'));
  assert.ok(!flagged('API_KEY="<your key goes here>"'));
  assert.ok(!flagged('API_KEY="${SOME VAR HERE}"'));
  assert.ok(!flagged('API_KEY="** ** ** ** **"'));
  assert.ok(!flagged('API_KEY="a b c d e f g h i j"'));
  // unterminated: only the first token is taken, as before
  assert.deepEqual(values('API_KEY="' + V + ' and some more words'), [V]);
});

test('setx: Windows environment variables', () => {
  assert.deepEqual(values('setx API_KEY ' + V), [V]);
  assert.deepEqual(names('setx API_KEY ' + V), ['API_KEY']);
  assert.deepEqual(values('setx API_KEY "' + V + '"'), [V]);
  assert.deepEqual(values('setx /M DB_PASSWORD ' + V), [V]);
  assert.deepEqual(values('SETX "API_KEY" "' + V + '"'), [V]);
  assert.deepEqual(values('setx API_KEY "abc def ghijkl"'), ['abc def ghijkl']);
  assert.ok(!flagged('setx API_KEY %API_KEY%'));
  assert.ok(!flagged('setx API_KEY YOUR_API_KEY'));
  assert.ok(!flagged('setx API_KEY <your-key>'));
  assert.ok(!flagged('setx PATH ' + V), 'name is not sensitive');
  assert.ok(!flagged('setx API_KEY'));
  assert.ok(!flagged('setx API_KEY short'));
});

test('Authorization headers: Bearer, Basic and Token', () => {
  assert.deepEqual(values('Authorization: Bearer ' + V), [V]);
  assert.deepEqual(names('Authorization: Bearer ' + V), ['AUTHORIZATION']);
  assert.deepEqual(values('authorization: bearer ' + V), [V]);
  assert.deepEqual(values('Authorization: Basic ' + B), [B]);
  assert.deepEqual(values('Authorization: Token ' + V), [V]);
  assert.deepEqual(values('curl -H "Authorization: Bearer ' + V + '" https://api.example.com'), [V]);
  assert.deepEqual(values("curl -H 'Authorization: Bearer " + V + "'"), [V]);
  assert.deepEqual(values('Proxy-Authorization: Basic ' + B), [B]);
  assert.deepEqual(values('{"Authorization": "Bearer ' + V + '"}'), [V]);
  assert.deepEqual(values(BS + Q + 'Authorization' + BS + Q + ': ' + BS + Q + 'Bearer ' + V + BS + Q), [V]);
  assert.deepEqual(values('Authorization=Bearer ' + V), [V]);
  assert.deepEqual(values('Use Authorization: Bearer ' + V + '.'), [V]);
});

test('Authorization headers: placeholders, references and prose are not flagged', () => {
  for (const t of [
    'Authorization: Bearer YOUR_API_KEY',
    'Authorization: Bearer <token>',
    'Authorization: Bearer ${TOKEN}',
    'Authorization: Bearer $TOKEN',
    'Authorization: Bearer %TOKEN%',
    'Authorization: Bearer {token}',
    'Authorization: Bearer xxxxxxxxxxxx',
    'Authorization: Bearer ************',
    'Authorization: Bearer __ZN_API_KEY__',
    'Authorization: Bearer your-token-here',
    'Authorization: Bearer token',
    'Authorization: Bearer eyJhbGci...',
    'Authorization: Bearer process.env.TOKEN',
    'Authorization: Basic authentication',
    'Authorization: Bearer abcdefghijkl',
    'The Authorization header carries a Bearer token',
    'Authorization: required',
    'authorization=Bearer',
  ]) assert.ok(!flagged(t), t);
});

test('next-line values are still not taken (known limit)', () => {
  assert.ok(!flagged('API_KEY=\n' + V));
  assert.ok(!flagged('Authorization: Bearer\n' + V));
});

test('docs about environment variables with placeholder values stay quiet', () => {
  for (const t of [
    'Set `API_KEY=<your-key>` in your shell.',
    'export API_KEY="YOUR_API_KEY"',
    'setx API_KEY "your-api-key"',
    'API_KEY=xxxxxxxxxxxx',
    'API_KEY=********',
    'API_KEY="****************"',
    'DB_PASSWORD=`changeme`',
    'curl -H "Authorization: Bearer $API_KEY" https://api.example.com',
  ]) assert.ok(!flagged(t), t);
});

test('1 MiB prompts: the new forms stay linear', () => {
  const N = 1024 * 1024;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const shapes = {
    backticks_only: '`'.repeat(N),
    escaped_quotes_only: rep(BS + Q),
    many_escaped_names: rep(BS + Q + 'api_key' + BS + Q + ': '),
    escaped_names_open_values: rep(BS + Q + 'api_key' + BS + Q + ': ' + BS + Q + 'aaaa '),
    open_quoted_spaces: rep('API_KEY="a b '),
    open_quoted_long: 'API_KEY="' + 'a '.repeat(N / 2 - 9),
    open_backtick_repeat: rep('API_KEY=`' + 'z'.repeat(30) + ' '),
    backslash_runs: rep(BS.repeat(50) + 'x'),
    backslash_then_quote: 'API_KEY="' + rep(BS + Q),
    setx_repeated: rep('setx API_KEY '),
    setx_open_quote: rep('setx API_KEY "a b '),
    setx_spaces: 'setx' + ' '.repeat(N / 2) + 'API_KEY' + ' '.repeat(N / 2 - 12),
    auth_repeated: rep('Authorization: Bearer '),
    auth_long_token: 'Authorization: Bearer ' + 'a1'.repeat(N / 2 - 12),
    auth_spaces: 'Authorization:' + ' '.repeat(N - 20),
    auth_name_repeated: rep('Proxy-Authorization'),
    auth_quote_runs: rep('authorization' + BS + Q + BS + Q),
  };
  for (const [label, text] of Object.entries(shapes)) {
    const t0 = process.hrtime.bigint();
    findPromptAssignments(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 3000, label + ' took ' + ms.toFixed(0) + ' ms');
  }
});
