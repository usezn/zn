'use strict';

// Credential assignments under environment-style names (secret:env_credential,
// secret:prefixed_credential, secret:credential_default): secrets are
// redacted; references, code and placeholders are not. The Python package
// runs the same cases (tests/test_rules_parity.py, TestPrefixedCredentialNames).
// Values are synthetic and built from pieces.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

const RANDOM_24 = 'Zx9' + 'kQ2mN8pL' + '4rT6vW1y' + 'Hc5J0';
const RANDOM_40 = 'aB3dE5fG7h' + 'J9kL2mN4pQ' + '6rS8tU0vW1' + 'xY3zA5bC7d';

function redacted(text, value) {
  const { sanitized, detections } = redactSecrets(text);
  assert.ok(!sanitized.includes(value), `not redacted: ${text}`);
  assert.ok(detections.length > 0, `no detection: ${text}`);
}

function kept(text) {
  const { sanitized, detections } = redactSecrets(text);
  assert.equal(sanitized, text);
  assert.deepEqual(detections, []);
}

test('prefixed environment-style names are redacted', () => {
  const value = 'Kp4r'.repeat(5);
  for (const name of ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'GITHUB_AUTH_TOKEN', 'DB_PASSWORD', 'APP_SECRET', 'REDIS_PWD', 'GCP_CREDENTIALS']) {
    for (const sep of ['=', ': ', ' = ', '="']) redacted(name + sep + value, value);
  }
  redacted(`"OPENAI_API_KEY": "${value}"`, value);
  redacted(`ENV HF_TOKEN ${value}`, value);
});

test('PHP and PowerShell assignments are redacted; $NAME: and ${NAME} are references', () => {
  redacted(`$API_KEY = '${RANDOM_24}';`, RANDOM_24);
  redacted(`$OPENAI_API_KEY = '${RANDOM_24}';`, RANDOM_24);
  redacted(`$env:DEPLOY_TOKEN = "${RANDOM_24}"`, RANDOM_24);
  kept('echo $DB_PASSWORD:' + 'x7'.repeat(8));
  kept('echo ${DB_PASSWORD}' + 'x7'.repeat(8));
});

test('machine-generated values with code-like shapes stay secrets', () => {
  const cases = [
    ['MAPBOX_SECRET_TOKEN=', 'sk.eyJ1Ijoi' + 'Zm9vYmFy'.repeat(4) + 'In0.' + 'QwErTy12' + 'AsDfGh34Zx'],
    ['SENDGRID_API_KEY=', 'SG.' + 'Ab3cD4eF5gH6iJ7kL8mN9q' + '.' + 'pQ1r'.repeat(10) + 'sT2'],
    ['DOPPLER_TOKEN=', 'dp.st.prd.' + RANDOM_40],
    ['VAULT_TOKEN=', 'hvs.' + RANDOM_24],
    ['AWS_BACKUP_SECRET_ACCESS_KEY=', '/' + RANDOM_40.slice(0, 39)],
    ['BROKER_PASSWORD=', 'amqps://app:' + RANDOM_24 + '@mq.internal/vh'],
    ['DB_PASSWORD=', 'Tr0(b4)[x]{9}' + 'Qz'.repeat(2)],
    ['DB_PASSWORD=', 'Maple(River)' + 'StoneCopper'],
    ['APP_PASSPHRASE_SECRET=', 'orbit.maple.' + 'harbor.cinder'],
    ['api_key: ', 'orbit-maple-' + 'harbor-cinder'],
    ["SECRET_KEY = '", 'k9(x#2_q'.repeat(6)],
  ];
  for (const [prefix, value] of cases) redacted(prefix + value, value);
});

test('code, references and placeholders are left alone', () => {
  for (const text of [
    '  OPENAI_API_KEY: z.string().min(1),',
    'const S3_SECRET_KEY = process.env.S3_SECRET_KEY;',
    'R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,',
    'SESSION_SECRET = os.urandom(32).hex()',
    "JWT_SECRET = crypto.randomBytes(64).toString('hex')",
    'let API_TOKEN = std::env::var("API_TOKEN")?;',
    "DB_PASSWORD = Secret.fromSecretNameV2(this, 'db')",
    'STRIPE_API_KEY = Rails.application.credentials.stripe',
    'OPENAI_API_KEY = FAKE.apiKey,',
    'TAVSU_ACCESS_KEY = secrets.token_urlsafe(48)',
    'API_KEY=@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/k/)',
    'API_TOKEN=secretref:app-secrets/api-token',
    'API_KEY=projects/demo/secrets/api-key/versions/3',
    'BROKER_PASSWORD=amqps://app:${MQ_PASS}@mq.internal/vh',
    'GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json',
    'SECRET_KEY=please-change-this-value',
    'API_TOKEN=not-set-in-dev',
    'JWT_SECRET=set-me-in-production',
    'API_TOKEN=fake-token-for-tests',
    'PROVIDER_API_KEY=mock-provider-key',
    'STRIPE_SECRET_KEY=sk_live_' + 'x'.repeat(24),
    'SECRET_KEY=00000000-0000-0000-0000-000000000000',
    'DB_PASSWORD=__ZN_DB_PASSWORD__',
    'POSTGRES_PASSWORD: ${DB_PASSWORD:-difyai123456}',
  ]) kept(text);
});

test('generated values with placeholder marks are redacted; whole placeholders are not', () => {
  for (const value of ['<' + RANDOM_24 + '!#', '[' + RANDOM_24 + '%&', RANDOM_24 + '${' + 'Q9!', RANDOM_24.slice(0, 8) + '{{' + RANDOM_24.slice(8) + '^', RANDOM_24 + '***' + '7!']) {
    redacted(`API_KEY="${value}"`, value);
    redacted(`STRIPE_SECRET_KEY="${value}"`, value);
  }
  for (const text of ['API_KEY=sk-proj-****', 'API_KEY=<your-key-here>', 'API_KEY=${VAR_NAME_HERE}', 'API_KEY=' + '*'.repeat(16)]) kept(text);
});

test('object names, file names and host names are left alone', () => {
  for (const text of ['IMAGE_PULL_SECRET=regcred-ghcr', 'TLS_SECRET: ingress-nginx-tls', 'GOOGLE_APPLICATION_CREDENTIALS=service-account.json',
    'KEYSTORE_PASSWORD=android-release.keystore', 'SMTP_PASSWORD=smtp.sendgrid.net', 'X_PASSWORD=ask-the-ops-team', 'APP_TOKEN=xx-aaaaaaaaaaaa']) kept(text);
  redacted('JWT_SECRET=orbit-maple-harbor-cinder', 'orbit-maple-harbor-cinder');
  redacted('DB_PASSWORD=orbit-maple-harbor', 'orbit-maple-harbor');
});

test('reference shapes with random content are redacted; real references are not', () => {
  const inner = RANDOM_24.slice(0, 15);
  for (const value of ['!' + inner, '@' + inner + '@', '[' + inner + ']', '$' + inner, '%' + inner + '%']) redacted('API_KEY=' + value, value);
  for (const text of ['X_SECRET: !ImportValue', 'X_TOKEN: $$X_TOKEN_VAR', 'X_PASSWORD=@app.x_password@', 'DEPLOY_TOKEN=$DEPLOY_TOKEN_FROM_CI', 'API_KEY=[YOUR_API_KEY_HERE]']) kept(text);
});

test('PHP, Perl and PowerShell references are left alone', () => {
  for (const text of ["$API_KEY = $this->config->get('api_key');", 'my $API_TOKEN = $config->{api_token};', '$env:GITHUB_TOKEN = $env:GITHUB_TOKEN_PROD']) kept(text);
});

test('a compose default is redacted only when it looks generated', () => {
  const { sanitized, detections } = redactSecrets('JWT_SECRET: ${JWT_SECRET:-' + RANDOM_24 + '}');
  assert.equal(sanitized, 'JWT_SECRET: ${JWT_SECRET:-[REDACTED_SECRET]}');
  assert.deepEqual(detections.map((d) => d.rule), ['secret:credential_default']);
  kept('SECRET_KEY: ${SECRET_KEY:-change-me-in-production}');
});

test('the value checks are bounded per call; later matches are redacted', () => {
  const { MAX_FILTERED_CHARS } = require('../lib/rules');
  const line = 'SERVICE_TOKEN=process.env.SERVICE_TOKEN_VALUE';
  const lines = redactSecrets(Array(Math.floor(MAX_FILTERED_CHARS / 31) + 50).fill(line).join('\n')).sanitized.split('\n');
  assert.equal(lines[0], line);
  assert.equal(lines[lines.length - 1], 'SERVICE_TOKEN=[REDACTED_SECRET]');
});
