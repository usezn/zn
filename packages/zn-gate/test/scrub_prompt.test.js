'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findPromptAssignments } = require('../lib/scrub/prompt');
const { decidePrompt } = require('../lib/hooks/runner');

// Prompts that hand a credential to the model: each must be blocked.
const POSITIVES = [
  ['my key is STRIPE_KEY=2342342342asfsdfsdf', 'STRIPE_KEY', '2342342342asfsdfsdf'],
  ['STRIPE_KEY=2342342342asfsdfsdf', 'STRIPE_KEY', '2342342342asfsdfsdf'],
  ['my key is STRIPE_KEY=sk_live_2342342342asfsdfsdf, why does checkout fail?', 'STRIPE_KEY', 'sk_live_2342342342asfsdfsdf'],
  ['DB_PASSWORD=sunshine2024, can you connect?', 'DB_PASSWORD', 'sunshine2024'],
  ['use OPENAI_API_KEY="abc123def456" for the test', 'OPENAI_API_KEY', 'abc123def456'],
  ["set GITHUB_TOKEN='tok12345678' and push", 'GITHUB_TOKEN', 'tok12345678'],
  ['the prod one is API_KEY: q7w8e9r0t1y2.', 'API_KEY', 'q7w8e9r0t1y2'],
  ['here: {"api_key": "a1b2c3d4e5f6"}', 'API_KEY', 'a1b2c3d4e5f6'],
  ['apiKey=Mx9secretvalue7 is what the vendor gave me', 'API_KEY', 'Mx9secretvalue7'],
  ['password=letmein2024 for the admin user', 'PASSWORD', 'letmein2024'],
  ['curl https://api.example.com/v1?api_key=k9k9k9k9k9k9 returns 401', 'API_KEY', 'k9k9k9k9k9k9'],
  ['SENTRY_DSN=https://abc123@o1.ingest.sentry.io/1 breaks', null, null],
  ['{"password": "sunshine2024"}', 'PASSWORD', 'sunshine2024'],
  ['{"token":"q7w8e9r0t1y2"}', 'TOKEN', 'q7w8e9r0t1y2'],
  ['try it (STRIPE_KEY=2342342342asfsdfsdf)', 'STRIPE_KEY', '2342342342asfsdfsdf'],
  ['STRIPE_KEY=2342342342asfsdfsdf; then retry', 'STRIPE_KEY', '2342342342asfsdfsdf'],
  ['[API_KEY=q7w8e9r0t1y2]', 'API_KEY', 'q7w8e9r0t1y2'],
  ['API_KEY=' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7'.repeat(9), 'API_KEY', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7'.repeat(9)],
  ['DATABASE_URL=postgres://app:tr0ub4dor99@db:5432/app is wrong?', 'DATABASE_URL', 'postgres://app:tr0ub4dor99@db:5432/app'],
];

// Questions about configuration, documentation examples and pasted code with
// placeholders or references: none may be blocked.
const NEGATIVES = [
  'how do I set API_KEY=changeme123 in docker?',
  'set API_KEY=your_api_key_here in .env',
  'API_KEY=<your key> goes in the config',
  'use API_KEY=${API_KEY} in compose',
  'run with API_KEY=$API_KEY npm start',
  'export GITHUB_TOKEN=xxxxxxxxxxxx',
  'PASSWORD=********** is masked in the logs',
  'the token is __ZN_STRIPE_KEY__ now: STRIPE_KEY=__ZN_STRIPE_KEY__',
  'my token: abcdefgh123',
  'the password: required field is missing',
  'const apiKey = process.env.API_KEY',
  "password = request.form.get('password')",
  'api_key = self.api_key',
  'token = response.json()["token"]',
  'secret = secrets.token_hex(32)',
  'API_KEY=os.getenv("API_KEY")',
  'new_password = old_password',
  'apiKey: string;',
  'secret_key: Optional[str] = None',
  'password: str = Field(min_length=8)',
  'SECRET_KEY = settings.SECRET_KEY',
  'api_key=new_api_key',
  'auth_token=authTokenValue',
  'AUTH_PROVIDER=auth0provider is what we use',
  'PUBLIC_KEY=MIIBIjANBgkqhkiG9w0 is public',
  'TOKEN_URL=https://auth.example.com/oauth/token',
  'CACHE_KEY=user-profile-v2 in redis',
  'API_KEY=true',
  'API_KEY=12345',
  'PASSWORD_MIN_LENGTH=12345678',
  'KEY=abcdefghij is a cache entry',
  'the API_KEY= line is empty',
  'GITHUB_TOKEN=secrets.GITHUB_TOKEN in the workflow',
  'API_KEY=example-key-123 from the docs',
  'API_KEY=dummyvalue123 for tests',
  'SECRET=placeholder_value',
  'what is the difference between API_KEY and API_SECRET?',
  'TOKEN_TTL=3600 seconds',
  'JWT_SECRET_PATH=/etc/app/jwt',
  'SSH_AUTH_SOCK=/tmp/ssh-agent.sock',
  '{"password": "required"}',
  '{"token": "string"}',
  '{"token": "<token>"}',
  '{"password": "${DB_PASSWORD}"}',
  'call getToken() with API_KEY=getToken()',
];

test('prompt layer: credentials typed into a prompt are found, with their name', () => {
  let found = 0;
  for (const [text, name, value] of POSITIVES) {
    const r = findPromptAssignments(text);
    assert.ok(r.length >= 1, 'not found: ' + text);
    if (name) {
      assert.equal(r[0].name, name, text);
      assert.equal(text.slice(r[0].start, r[0].end), value, text);
    }
    found++;
  }
  assert.equal(found, POSITIVES.length);
});

test('prompt layer: placeholders, references, code and prose are left alone', () => {
  const hits = NEGATIVES.filter((t) => findPromptAssignments(t).length > 0);
  assert.deepEqual(hits, [], 'false positives: ' + hits.length + '/' + NEGATIVES.length);
});

test('prompt layer: a credential after a long pasted log is still found', () => {
  const text = 'log line with nothing in it\n'.repeat(3000) + 'my key is STRIPE_KEY=2342342342asfsdfsdf';
  assert.ok(text.length > 64 * 1024);
  assert.equal(findPromptAssignments(text).length, 1);
});

test('prompt layer: bounded work on long input', () => {
  const long = ('API_KEY=' + 'x'.repeat(30) + ' ').repeat(20000);
  const t0 = Date.now();
  findPromptAssignments(long);
  assert.ok(Date.now() - t0 < 2000);
});

function deps(spans = []) {
  return {
    engine: () => ({ scan: () => spans }),
    vault: async () => null,
    detectors: () => [],
  };
}

test('prompt hook blocks a typed credential and suggests zn secret set with its name', async () => {
  const ev = { event: 'user_prompt', input: { prompt: 'my key is STRIPE_KEY=2342342342asfsdfsdf' } };
  const d = await decidePrompt(ev, deps(), 'claude-code');
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /contains a secret \(STRIPE_KEY\)/);
  assert.match(d.message, /secret set STRIPE_KEY/);
  assert.match(d.message, /ask your agent to use it/);
});

test('prompt hook allows a question about configuration with a placeholder', async () => {
  const ev = { event: 'user_prompt', input: { prompt: 'how do I set API_KEY=changeme123 in docker?' } };
  assert.equal((await decidePrompt(ev, deps(), 'claude-code')).decision, 'allow');
});
