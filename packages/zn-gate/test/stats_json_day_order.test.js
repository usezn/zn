'use strict';
// stats --json: the days that sharing sends come out in ascending day order,
// whatever order the stats file lists them in (local stub, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-stats-day-order-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

const realRequest = https.request;
test.after(() => { https.request = realRequest; fs.rmSync(home, { recursive: true, force: true }); });

const dayAgo = (n) => stats.today(new Date(Date.now() - n * 86400000));
const D0 = dayAgo(3);
const D1 = dayAgo(2);
const D2 = dayAgo(1);

// Every POST succeeds.
function stubOk() {
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('end'); });
    };
    return req;
  };
}

// The later day is written first in the stats file.
function setup() {
  for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true });
  const e = { 'hook:claude-code': { checked: 3, blocked: 0, detections: {} } };
  fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, events: {}, days: { [D2]: e, [D1]: e } }));
  const cfgFile = path.join(path.dirname(stats.statsFile()), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ stats: { share: true, install_id: 'test-id', sent_until: D0 } }));
}

const run = async (args) => {
  let out = '';
  const code = await cli.run(args, (s) => { out += s; }, { confirm: async () => false });
  return { code, out };
};

test('--json lists the sent days in ascending order, whatever order the stats file has', async () => {
  setup();
  stubOk();
  const j = JSON.parse((await run(['--json'])).out);
  assert.deepEqual(j.sent_days, [D1, D2]);
  assert.equal(j.send_failed, 0);
});
