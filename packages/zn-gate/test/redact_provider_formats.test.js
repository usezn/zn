'use strict';

// Provider token formats are redacted by redactSecrets, sanitizeToolResult and
// the evidence preview, the same as the scrubber and the Python package do.
// Every token is random and built at run time from pieces; none is a real
// credential.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { redactSecrets, sanitizeToolResult } = require('../lib/rules');
const http = require('http');
const { logEvidence } = require('../lib/evidence');
const { checkToolResult, analyze } = require('../lib/client');
const gateMcp = require('../lib/mcp');
const pins = require('../lib/mcp-pins');
const { _internal: reachInternal } = require('../lib/reach');

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const DIGITS = '0123456789';
let seed = 987654;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const r = (n, al = ALNUM) => Array.from({ length: n }, () => al[Math.floor(rnd() * al.length)]).join('');

const FORMATS = {
  gitlab: ['secret:gitlab_token', () => 'glp' + 'at-' + r(20)],
  slack: ['secret:slack_token', () => 'xox' + 'b-' + r(11, DIGITS) + '-' + r(12, DIGITS) + '-' + r(24)],
  stripe_secret: ['secret:stripe_key', () => 'sk_' + 'live_' + r(24)],
  stripe_restricted: ['secret:stripe_key', () => 'rk_' + 'live_' + r(24)],
  google_api: ['secret:google_api_key', () => 'AI' + 'za' + r(35)],
  sendgrid: ['secret:sendgrid_key', () => 'SG' + '.' + r(22) + '.' + r(43)],
  huggingface: ['secret:hf_token', () => 'hf' + '_' + r(34)],
  npm: ['secret:npm_token', () => 'npm' + '_' + r(36)],
  pypi: ['secret:pypi_token', () => 'pypi' + '-AgE' + r(60)],
  twilio: ['secret:twilio_key', () => 'S' + 'K' + r(32, HEX)],
  digitalocean: ['secret:digitalocean_token', () => 'dop' + '_v1_' + r(64, HEX)],
  shopify: ['secret:shopify_token', () => 'shp' + 'at_' + r(32, HEX)],
  mailgun: ['secret:mailgun_key', () => 'key' + '-' + r(32, HEX)],
  databricks: ['secret:databricks_token', () => 'dap' + 'i' + r(32, HEX)],
  linear: ['secret:linear_key', () => 'lin' + '_api_' + r(40)],
  doppler: ['secret:doppler_token', () => 'dp' + '.pt.' + r(43)],
  pulumi: ['secret:pulumi_token', () => 'pu' + 'l-' + r(40, HEX)],
  stripe_test: ['secret:stripe_key', () => 'sk_' + 'test_' + r(24)],
  stripe_webhook: ['secret:stripe_webhook_secret', () => 'whsec' + '_' + r(40)],
  slack_user: ['secret:slack_token', () => 'xox' + 'p-' + r(11, DIGITS) + '-' + r(12, DIGITS) + '-' + r(24)],
  slack_app: ['secret:slack_token', () => 'xap' + 'p-1-' + r(10, UPPER.slice(0, 26)) + '-' + r(11, DIGITS) + '-' + r(40, HEX)],
  slack_webhook: ['secret:slack_webhook', () => 'https://hooks.' + 'slack.com/services/T' + r(8, UPPER.slice(0, 26)) + '/B' + r(8, UPPER.slice(0, 26)) + '/' + r(24)],
  google_oauth: ['secret:google_oauth_secret', () => 'GOCS' + 'PX-' + r(28)],
  aws_asia: ['secret:aws_key_id', () => 'AS' + 'IA' + r(16, UPPER)],
  aws_abia: ['secret:aws_key_id', () => 'AB' + 'IA' + r(16, UPPER)],
  aws_acca: ['secret:aws_key_id', () => 'AC' + 'CA' + r(16, UPPER)],
  grafana: ['secret:grafana_token', () => 'gl' + 'sa_' + r(32) + '_' + r(8, HEX)],
};

async function mcpCall(name, args) {
  const replies = [];
  const real = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"jsonrpc":"2.0"')) { replies.push(JSON.parse(chunk)); return true; }
    return real.call(process.stdout, chunk, ...rest);
  };
  try {
    await gateMcp.handleRequest({ id: 1, method: 'tools/call', params: { name, arguments: args } }, { localOnly: true });
  } finally {
    process.stdout.write = real;
  }
  return replies;
}

for (const [name, [rule, make]] of Object.entries(FORMATS)) {
  test(`provider format ${name} is redacted`, async () => {
    const key = make();
    const text = `deploy log ${key} done for host.example.com`;

    const res = redactSecrets(text);
    assert.ok(!res.sanitized.includes(key), 'redactSecrets leaked the token');
    assert.ok(res.detections.some((d) => d.rule === rule), `rule ${rule} not reported: ${JSON.stringify(res.detections)}`);

    const str = sanitizeToolResult('read_file', text);
    assert.ok(!str.sanitized_content.includes(key), 'sanitizeToolResult (string) leaked the token');
    assert.ok(str.secrets_redacted >= 1);

    const deep = sanitizeToolResult({ a: { list: ['x', `k ${key}`], note: 'ok' } });
    assert.ok(!JSON.stringify(deep).includes(key), 'sanitizeToolResult (object) leaked the token');

    const viaClient = await checkToolResult('read_file', text, { localOnly: true });
    assert.ok(!JSON.stringify(viaClient).includes(key), 'checkToolResult leaked the token');

    const call = await mcpCall('check_tool_call', { tool_name: 'bash', arguments: { command: 'echo ' + key } });
    assert.ok(!JSON.stringify(call).includes(key), 'check_tool_call leaked the token');
    const result = await mcpCall('check_tool_result', { tool_name: 'read_file', content: text });
    assert.ok(!JSON.stringify(result).includes(key), 'check_tool_result leaked the token');

    assert.ok(!pins.label('node', ['server.js', '--token', key]).includes(key), 'pin label leaked the token');
    assert.ok(reachInternal.secretEnvNames({ PLAIN_NAME: key }).includes('PLAIN_NAME'), 'reach did not detect the value');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-redact-'));
    try {
      const rec = logEvidence({ agent: 'test', tool_name: 'bash', payload: text, verdict: 'allow' }, path.join(dir, 'evidence.jsonl'));
      assert.ok(rec && !rec.payload_preview.includes(key), 'evidence preview leaked the token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('ordinary text, hashes and UUIDs are left as they are', () => {
  const samples = [
    'The build finished in 42 seconds; see https://example.com/docs for details.',
    'sha256 ' + r(64, HEX) + ' and md5 ' + r(32, HEX),
    'id 123e4567-e89b-42d3-a456-426614174000 created',
    'commit ' + r(40, HEX) + ' on main',
    'key-value pairs, a sk_ prefix, hf_ and npm_ are only words here',
    'glpat is a prefix and pypi-publish is a command, SK is a letter pair',
  ];
  for (const s of samples) {
    const res = redactSecrets(s);
    assert.equal(res.sanitized, s);
    assert.deepEqual(res.detections, []);
  }
});

test('the text sent to the cloud analysis has the provider tokens redacted', async (t) => {
  const key = FORMATS.gitlab[1]();
  const slack = FORMATS.slack[1]();
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ verdict: 'allow', confidence: 0.1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const saved = { ZN_CLOUD: process.env.ZN_CLOUD, ZN_LOCAL_ONLY: process.env.ZN_LOCAL_ONLY };
  process.env.ZN_CLOUD = '1';
  delete process.env.ZN_LOCAL_ONLY;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const apiKey = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
  await analyze(`please use ${key} and ${slack} for the job`, { apiKey, apiUrl: 'http://127.0.0.1:' + server.address().port + '/v30/analyze' });
  assert.ok(seen.length >= 1, 'no request reached the stand-in gate');
  for (const body of seen) {
    assert.ok(!body.includes(key) && !body.includes(slack), 'a provider token was sent to the cloud');
  }
});
