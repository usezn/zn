'use strict';
// The scrubber masks the private_key field of a Google service-account JSON file and keeps the field name.
// The PEM header and body are fake placeholders, built from parts so that no literal here matches a key rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(path.resolve(__dirname, '..', 'lib', 'scrub', 'engine'));

const BEGIN = '-----BEGIN ' + 'PRIVATE KEY-----';
const END = '-----END ' + 'PRIVATE KEY-----';
const BODY = 'MIIEfakeplaceholderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const serviceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  private_key: BEGIN + '\n' + BODY + '\n' + END + '\n',
  client_email: 'svc@example-project.iam.gserviceaccount.com',
}, null, 2) + '\n';

async function masked(text) {
  const r = await E.tokenize(text, {});
  return typeof r === 'string' ? r : r.text;
}

test('the private_key value of a service-account file is masked as a whole', async () => {
  const out = await masked(serviceAccount);
  assert.match(out, /"private_key": "__ZN_REDACTED_SECRET__"/);
  assert.ok(!out.includes(BODY), 'key body leaked');
  assert.ok(!out.includes('BEGIN'), 'key header leaked');
  assert.ok(!out.includes(END), 'key footer leaked');
});

test('the other fields of the file are not masked away', async () => {
  const out = await masked(serviceAccount);
  assert.match(out, /"type": "service_account"/);
  assert.match(out, /"project_id": "example-project"/);
});
