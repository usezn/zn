'use strict';
// zn-gate stats with sharing on: only days whose POST succeeded are reported as shared (local stub, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-stats-sent-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const share = require('../lib/stats-share');
const cli = require('../lib/stats-cli');

const realRequest = https.request;
test.after(() => { https.request = realRequest; fs.rmSync(home, { recursive: true, force: true }); });

const dayAgo = (n) => stats.today(new Date(Date.now() - n * 86400000));
const D1 = dayAgo(2);
const D2 = dayAgo(1);

// failing: set of days whose POST gets a 500; 'error' makes the request fail with a network error.
function stub(failing) {
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      const day = JSON.parse(body).day;
      const mode = failing[day];
      if (mode === 'error') { setImmediate(() => req.emit('error', new Error('getaddrinfo ENETUNREACH'))); return; }
      const res = new EventEmitter();
      res.statusCode = mode === 'status' ? 500 : 200;
      res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('end'); });
    };
    return req;
  };
}

function setup() {
  for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true });
  fs.writeFileSync(stats.statsFile(), JSON.stringify({
    version: 1, events: {},
    days: {
      [D1]: { 'hook:claude-code': { checked: 5, blocked: 1, detections: { AWS_KEY: 1 } } },
      [D2]: { 'hook:claude-code': { checked: 4, blocked: 0, detections: {} } },
    },
  }));
  const cfgFile = path.join(path.dirname(stats.statsFile()), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ stats: { share: true, install_id: 'test-id', sent_until: D1 } }));
}
const run = async (args) => { let out = ''; const code = await cli.run(args, (s) => { out += s; }, { confirm: async () => false }); return { code, out }; };

test('a failed POST is not reported as shared (human output)', async () => {
  setup();
  stub({ [D1]: 'error', [D2]: 'error' });
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /Shared pseudonymous counts/);
  assert.match(r.out, /2 day\(s\) could not be shared/);
});

test('a failed POST is not listed in --json sent_days', async () => {
  setup();
  stub({ [D1]: 'status', [D2]: 'error' });
  const j = JSON.parse((await run(['--json'])).out);
  assert.deepEqual(j.sent_days, []);
  assert.equal(j.send_failed, 2);
});

test('mixed success and failure reports only the day that was sent', async () => {
  setup();
  stub({ [D1]: 'status' });
  const r = await run([]);
  assert.ok(r.out.includes(`Shared pseudonymous counts for ${D2}.`));
  assert.ok(!r.out.includes(`Shared pseudonymous counts for ${D1}.`));
  assert.match(r.out, /1 day\(s\) could not be shared/);
  setup();
  stub({ [D1]: 'status' });
  const j = JSON.parse((await run(['--json'])).out);
  assert.deepEqual(j.sent_days, [D2]);
  assert.equal(j.send_failed, 1);
});

test('sendPending returns the sent and the failed days', async () => {
  setup();
  stub({ [D2]: 'error' });
  const res = await share.sendPending();
  assert.deepEqual(res.sentDays, [D1]);
  assert.deepEqual(res.failedDays, [D2]);
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
});
