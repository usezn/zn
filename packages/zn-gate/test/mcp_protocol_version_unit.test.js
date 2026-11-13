'use strict';

// Direct unit tests of negotiateProtocolVersion and allowsBatching: every supported version, an older one,
// a newer one and values that are not strings.

const test = require('node:test');
const assert = require('node:assert/strict');
const proto = require('../lib/mcp-protocol');

const LATEST = '2025-11-25';

test('negotiateProtocolVersion echoes every supported version', () => {
  for (const v of proto.SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(proto.negotiateProtocolVersion({ protocolVersion: v }), v);
  }
});

test('negotiateProtocolVersion answers the latest for an older version', () => {
  assert.equal(proto.negotiateProtocolVersion({ protocolVersion: '2024-01-01' }), LATEST);
});

test('negotiateProtocolVersion answers the latest for a newer version', () => {
  assert.equal(proto.negotiateProtocolVersion({ protocolVersion: '2099-12-31' }), LATEST);
});

test('negotiateProtocolVersion answers the latest for a non-string version', () => {
  for (const v of [20250618, null, undefined, true, {}, ['2025-06-18'], NaN]) {
    assert.equal(proto.negotiateProtocolVersion({ protocolVersion: v }), LATEST, String(v));
  }
  for (const p of [undefined, null, {}, 'x']) {
    assert.equal(proto.negotiateProtocolVersion(p), LATEST, String(p));
  }
});

test('allowsBatching is true only for 2025-03-26 among supported versions', () => {
  for (const v of proto.SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(proto.allowsBatching(v), v === '2025-03-26', v);
  }
});

test('allowsBatching is false for older, newer and non-string versions', () => {
  for (const v of ['2024-01-01', '2099-12-31', '', 20250326, null, undefined, {}, ['2025-03-26']]) {
    assert.equal(proto.allowsBatching(v), false, String(v));
  }
});
