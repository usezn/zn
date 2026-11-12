'use strict';
// lib/stats-share.js: sendPending and ENDPOINT, with https.request replaced by a local stub (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-share-send-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const share = require('../lib/stats-share');

const realRequest = https.request;
test.after(() => { https.request = realRequest; fs.rmSync(home, { recursive: true, force: true }); });

// Fixed clock: the complete days inside the 3-day window are 2026-10-11, 2026-10-12 and 2026-10-13.
const NOW = new Date('2026-10-14T12:00:00Z');
const DAYS = ['2026-10-11', '2026-10-12', '2026-10-13'];
const cfgFile = () => path.join(path.dirname(stats.statsFile()), 'config.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));

function setup({ share: on = true, sentUntil = null } = {}) {
  for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true });
  const days = {};
  for (const d of DAYS) days[d] = { 'hook:claude-code': { checked: 3, blocked: 0, detections: {} } };
  days['2026-10-14'] = { 'hook:claude-code': { checked: 1, blocked: 0, detections: {} } };
  fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, days, events: {} }));
  const st = { share: on, install_id: on ? '00000000-0000-4000-8000-000000000000' : undefined };
  if (sentUntil) st.sent_until = sentUntil;
  fs.writeFileSync(cfgFile(), JSON.stringify({ stats: st }));
}

// outcome(day) returns a status code, or 'error' for a network error. Every call is recorded.
function stub(outcome = () => 200) {
  const calls = [];
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      calls.push({ opts, body });
      const mode = outcome(JSON.parse(body).day);
      if (mode === 'error') { setImmediate(() => req.emit('error', new Error('connect ECONNREFUSED 192.0.2.1:443'))); return; }
      const res = new EventEmitter();
      res.statusCode = mode;
      res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('end'); });
    };
    return req;
  };
  return calls;
}

test('ENDPOINT is the https telemetry URL', () => {
  assert.equal(share.ENDPOINT, 'https://api.usezn.com/v1/telemetry');
  assert.equal(new URL(share.ENDPOINT).protocol, 'https:');
});

test('each report is POSTed as JSON to the ENDPOINT host and path', async () => {
  setup();
  const calls = stub();
  await share.sendPending({ now: NOW });
  assert.equal(calls.length, DAYS.length);
  const u = new URL(share.ENDPOINT);
  for (const { opts, body } of calls) {
    assert.equal(opts.method, 'POST');
    assert.equal(opts.hostname, u.hostname);
    assert.equal(opts.path, u.pathname);
    assert.equal(opts.port, 443);
    assert.equal(opts.headers['content-type'], 'application/json');
    assert.equal(opts.headers['content-length'], Buffer.byteLength(body));
    assert.match(opts.headers['user-agent'], /^zn-gate\//);
  }
  assert.deepEqual(calls.map((c) => JSON.parse(c.body).day), DAYS);
});

test('with sharing off nothing is sent and nothing is printed', async () => {
  setup({ share: false });
  const calls = stub();
  const printed = [];
  const r = await share.sendPending({ now: NOW, print: (x) => printed.push(x) });
  assert.deepEqual(r, { sent: 0, failed: 0, sentDays: [], failedDays: [] });
  assert.equal(calls.length, 0);
  assert.equal(printed.length, 0);
});

test('all days sent: each report is printed and sent_until moves past the last day', async () => {
  setup();
  const calls = stub();
  const printed = [];
  const r = await share.sendPending({ now: NOW, print: (x) => printed.push(x) });
  assert.deepEqual(r, { sent: 3, failed: 0, sentDays: DAYS, failedDays: [] });
  assert.deepEqual(printed.map((p) => p.day), DAYS);
  assert.deepEqual(printed, calls.map((c) => JSON.parse(c.body)));
  assert.equal(readCfg().stats.sent_until, '2026-10-14');
  assert.equal(readCfg().stats.share, true);
});

test('a second run after everything was sent sends nothing', async () => {
  setup();
  stub();
  await share.sendPending({ now: NOW });
  const calls = stub();
  const r = await share.sendPending({ now: NOW });
  assert.deepEqual(r, { sent: 0, failed: 0, sentDays: [], failedDays: [] });
  assert.equal(calls.length, 0);
});

test('days before sent_until are not sent again', async () => {
  setup({ sentUntil: '2026-10-13' });
  const calls = stub();
  const r = await share.sendPending({ now: NOW });
  assert.deepEqual(r.sentDays, ['2026-10-13']);
  assert.equal(calls.length, 1);
  assert.equal(readCfg().stats.sent_until, '2026-10-14');
});

test('a failure stops sent_until from moving, later days are still sent', async () => {
  setup();
  stub((day) => (day === '2026-10-12' ? 500 : 200));
  const r = await share.sendPending({ now: NOW });
  assert.deepEqual(r, { sent: 2, failed: 1, sentDays: ['2026-10-11', '2026-10-13'], failedDays: ['2026-10-12'] });
  assert.equal(readCfg().stats.sent_until, '2026-10-12');
});

test('a failure on the first day leaves sent_until unchanged', async () => {
  setup({ sentUntil: '2026-10-10' });
  stub((day) => (day === '2026-10-11' ? 'error' : 200));
  const r = await share.sendPending({ now: NOW });
  assert.deepEqual(r.failedDays, ['2026-10-11']);
  assert.deepEqual(r.sentDays, ['2026-10-12', '2026-10-13']);
  assert.equal(readCfg().stats.sent_until, '2026-10-10');
});

test('only 2xx answers count as sent', async () => {
  const codes = { '2026-10-11': 204, '2026-10-12': 302, '2026-10-13': 404 };
  setup();
  stub((day) => codes[day]);
  const r = await share.sendPending({ now: NOW });
  assert.deepEqual(r, { sent: 1, failed: 2, sentDays: ['2026-10-11'], failedDays: ['2026-10-12', '2026-10-13'] });
  assert.equal(readCfg().stats.sent_until, '2026-10-12');
});

test('network errors on every day are reported as failures', async () => {
  setup();
  stub(() => 'error');
  const r = await share.sendPending({ now: NOW });
  assert.deepEqual(r, { sent: 0, failed: 3, sentDays: [], failedDays: DAYS });
  assert.equal(readCfg().stats.sent_until, undefined);
});
