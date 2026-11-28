'use strict';

// secret:cli_credential_arg: the secret of a command line (--password=X, --api-key X, curl -u user:X, mysql -pX,
// PGPASSWORD=X) is redacted by redactSecrets and by the scrubber, and references, placeholders and other tools'
// flags stay. The Python package reads the same fixture (packages/zn-gate-py/tests/test_cli_credential_arg.py).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('../lib/rules');
const engine = require('../lib/scrub/engine');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cli_credential_arg_cases.json'), 'utf8'));

function scrubbed(text) {
  let out = '';
  let cur = 0;
  for (const s of engine.scan(text, { exact: false }).sort((a, b) => a.start - b.start)) {
    if (s.start < cur) continue;
    out += text.slice(cur, s.start) + '[REDACTED_' + s.type + ']';
    cur = s.end;
  }
  return out + text.slice(cur);
}

fixture.cases.forEach((c, i) => {
  test(`redactSecrets, case ${i}: ${c.text.slice(0, 50)}`, () => {
    const r = redactSecrets(c.text);
    assert.equal(r.sanitized, c.sanitized);
    // --api_key=X is already caught by secret:env_credential, which runs first
    assert.equal(r.detections.length > 0, c.sanitized !== c.text);
  });
  test(`the scrubber agrees with redactSecrets, case ${i}`, () => {
    assert.equal(scrubbed(c.text), c.sanitized);
  });
});

test('the rule is idempotent and keeps the text around the value', () => {
  const once = redactSecrets('curl -u admin:Zq7!mK2xP9vL https://api.example.com/x -H "A: b"').sanitized;
  assert.equal(once, 'curl -u admin:[REDACTED_SECRET] https://api.example.com/x -H "A: b"');
  assert.equal(redactSecrets(once).sanitized, once);
});

test('-p is a password only after a mysql or mariadb command', () => {
  for (const cmd of ['ssh -pZq7mK2xP9vL host.example.com', 'tar -pZq7mK2xP9vL a.tar', 'docker run -pZq7mK2xP9vL:80 x']) {
    assert.equal(redactSecrets(cmd).sanitized, cmd, cmd);
  }
  assert.equal(redactSecrets('mysql -h db.example.com -pZq7mK2xP9vL').sanitized, 'mysql -h db.example.com -p[REDACTED_SECRET]');
});

test('user:pass is a credential only after curl', () => {
  for (const cmd of ['docker run -u app:Zq7mK2xP9vL img', 'ssh -u app:Zq7mK2xP9vL host', 'chown -R user:group dir']) {
    assert.equal(redactSecrets(cmd).sanitized, cmd, cmd);
  }
});

test('a long run of flags and spaces stays linear', () => {
  const texts = [
    'curl ' + '-u '.repeat(50000),
    'curl ' + 'x '.repeat(50000) + '-u a:',
    'mysql ' + '-p '.repeat(50000),
    'mysql ' + 'x '.repeat(50000) + '-p',
    '--password ' + ' '.repeat(200000) + 'x',
    '--token='.repeat(30000),
    'PGPASSWORD='.repeat(30000),
    ('curl ' + 'a'.repeat(250) + ' ').repeat(2000),
  ];
  for (const text of texts) {
    const t0 = process.hrtime.bigint();
    redactSecrets(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${ms} ms on a ${text.length}-character input`);
  }
});
