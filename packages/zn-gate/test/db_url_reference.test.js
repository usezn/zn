'use strict';
// A database URL whose password is only a reference is not a secret; a literal password still is.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

test('db_url_password skips references and keeps literals', () => {
  for (const t of ['postgres://app:${PGPASSWORD}@db.example.com/app', 'mysql://app:$DB_PASS@db.example.com', 'redis://app:%REDIS_PASSWORD%@cache.example.com',
    'amqp://app:<password>@mq.example.com', 'mongodb://app:{{ password }}@db.example.com', 'postgres://app:{{password}}@db.example.com']) {
    assert.equal(redactSecrets(t).sanitized, t, t);
  }
  for (const t of ['postgres://app:ZnTestFakePw42x@db.example.com/app', 'mysql://app:$literal$pw9@db.example.com', 'redis://app:pw%20x@cache.example.com',
    'postgres://app:$kR7vQ2mZx9LpW4@db.example.com', 'mysql://app:%Passw0rd%@db.example.com', 'postgres://app:<R3al!Pw>@db.example.com', 'postgres://app:{{Tr0ub4dor&3}}@db.example.com',
    // Literal passwords that only look like references: lower-case $word or %word%, digits inside <> or {{ }}.
    'mysql://app:$password1@db.example.com', 'mysql://app:$xk7q9m2zp4wq@db.example.com', 'redis://app:%hunter2%@cache.example.com',
    'postgres://app:{{s3cr3t}}@db.example.com', 'mysql://app:$pass@db.example.com']) {
    assert.match(redactSecrets(t).sanitized, /\[REDACTED_DB_PASSWORD\]/, t);
  }
});

test('a scheme that combines a database and a driver name is redacted', () => {
  const { findPatterns } = require('../lib/scrub/patterns');
  const fake = 'ZnTestFakePw42x';
  for (const t of ['oracle+cx_oracle://app:' + fake + '@db.example.invalid/x', 'postgresql+psycopg2://app:' + fake + '@db.example.invalid/x',
    'mssql+pyodbc://app:' + fake + '@db.example.invalid/x', 'my_scheme://app:' + fake + '@db.example.invalid/x',
    'x_oracle+cx_oracle://app:' + fake + '@db.example.invalid/x']) {
    assert.ok(!redactSecrets(t).sanitized.includes(fake), t);
    assert.ok(findPatterns(t).some((s) => t.slice(s.start, s.end) === fake), t);
  }
  const ref = 'oracle+cx_oracle://app:${DB_PASS}@db.example.invalid/x';
  assert.equal(redactSecrets(ref).sanitized, ref);
});
