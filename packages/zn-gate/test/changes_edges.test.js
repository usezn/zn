'use strict';
/* Edge cases of restrictionChanges and describeChange (current behaviour). */
const test = require('node:test');
const assert = require('node:assert');
const { restrictionChanges, describeChange } = require('../lib/team/changes');

const pol = (version, rules, extra) => Object.assign({ org: 'org_TestOrg12345678', version, rules }, extra || {});
const rule = (secret, extra) => Object.assign({ secret, agents: ['*'] }, extra);

test('restrictionChanges accepts missing or malformed policies', () => {
  const empty = { items: [], more: 0 };
  assert.deepStrictEqual(restrictionChanges(undefined, undefined), empty);
  assert.deepStrictEqual(restrictionChanges(null, null), empty);
  assert.deepStrictEqual(restrictionChanges({}, {}), empty);
  assert.deepStrictEqual(restrictionChanges(pol(1, 'nope'), pol(2, null)), empty);
});

test('a missing new policy lifts every restriction of the old one', () => {
  const old = pol(1, [rule('A_KEY', { deny: true })], { detectors: [{ id: 'my_fmt' }] });
  assert.deepStrictEqual(restrictionChanges(old, undefined).items, [
    { kind: 'block_removed', secret: 'A_KEY' },
    { kind: 'detector_removed', values: ['my_fmt'] },
  ]);
});

test('a warning that became a block, and a block that stays, are not reported', () => {
  assert.deepStrictEqual(restrictionChanges(pol(1, [rule('A', { warn: true })]), pol(2, [rule('A', { deny: true })])).items, []);
  assert.deepStrictEqual(restrictionChanges(pol(1, [rule('A', { deny: true, warn: true })]), pol(2, [rule('A', { warn: true })])).items,
    [{ kind: 'block_removed', secret: 'A' }]);
});

test('host lists: removal of the limit, widening, ports and wildcards', () => {
  const lim = (hosts) => pol(1, [rule('A', { allowHosts: hosts })]);
  const none = pol(2, [rule('A')]);
  assert.deepStrictEqual(restrictionChanges(lim(['a.example.com']), none).items, [{ kind: 'hosts_unlimited', secret: 'A' }]);
  assert.deepStrictEqual(restrictionChanges(lim(['a.example.com']), lim(['a.example.com', 'b.example.com'])).items,
    [{ kind: 'hosts_widened', secret: 'A', values: ['b.example.com'] }]);
  // Narrowing or a case-only difference is not a loosening.
  assert.deepStrictEqual(restrictionChanges(lim(['a.example.com', 'b.example.com']), lim(['a.example.com'])).items, []);
  assert.deepStrictEqual(restrictionChanges(lim(['A.Example.com']), lim(['a.example.com'])).items, []);
  // A wildcard covers subdomains but not the bare domain.
  assert.deepStrictEqual(restrictionChanges(lim(['*.example.com']), lim(['x.example.com'])).items, []);
  assert.deepStrictEqual(restrictionChanges(lim(['*.example.com']), lim(['example.com'])).items,
    [{ kind: 'hosts_widened', secret: 'A', values: ['example.com'] }]);
  // An empty old list limits everything; any new host loosens it.
  assert.deepStrictEqual(restrictionChanges(lim([]), lim(['a.example.com'])).items,
    [{ kind: 'hosts_widened', secret: 'A', values: ['a.example.com'] }]);
  // Entries with a port never match, so they are ignored on both sides.
  assert.deepStrictEqual(restrictionChanges(lim(['a.example.com:8443']), lim(['a.example.com:8443'])).items, []);
});

test('command lists match whole words only', () => {
  const lim = (c) => pol(1, [rule('A', { allowCommands: c })]);
  assert.deepStrictEqual(restrictionChanges(lim(['curl']), lim(['curl -s'])).items, []);
  assert.deepStrictEqual(restrictionChanges(lim(['curl']), lim(['curlx'])).items,
    [{ kind: 'commands_widened', secret: 'A', values: ['curlx'] }]);
  assert.deepStrictEqual(restrictionChanges(lim(['curl']), pol(2, [rule('A')])).items, [{ kind: 'commands_unlimited', secret: 'A' }]);
});

test('placement changes', () => {
  const at = (p) => pol(1, [rule('A', p ? { injectAt: p } : {})]);
  assert.deepStrictEqual(restrictionChanges(at('header'), at(null)).items, [{ kind: 'placement_unlimited', secret: 'A' }]);
  assert.deepStrictEqual(restrictionChanges(at('header'), at('query')).items,
    [{ kind: 'placement_widened', secret: 'A', values: ['query'] }]);
  assert.deepStrictEqual(restrictionChanges(at('header'), at('header')).items, []);
  assert.deepStrictEqual(restrictionChanges(at(null), at('body')).items, []);
});

test('a wildcard rule removed is reported under its own pattern', () => {
  assert.deepStrictEqual(restrictionChanges(pol(1, [rule('*', { deny: true })]), pol(2, [])).items, [{ kind: 'block_removed', secret: '*' }]);
});

test('items are capped at 20 and values at 5, with the rest counted', () => {
  const rules = [];
  for (let i = 0; i < 25; i++) rules.push(rule('S' + String(i).padStart(2, '0'), { deny: true }));
  const r = restrictionChanges(pol(1, rules), pol(2, []));
  assert.strictEqual(r.items.length, 20);
  assert.strictEqual(r.more, 5);
  assert.strictEqual(r.items[0].secret, 'S00');
  const hosts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => x + '.example.com');
  const w = restrictionChanges(pol(1, [rule('A', { allowHosts: ['z.example.com'] })]), pol(2, [rule('A', { allowHosts: ['z.example.com'].concat(hosts) })]));
  assert.deepStrictEqual(w.items[0].values, hosts.slice(0, 5));
  assert.strictEqual(w.more, 0);
});

test('detectors: only removed ids are reported', () => {
  const r = restrictionChanges(pol(1, [], { detectors: [{ id: 'one' }, { id: 'two' }] }), pol(2, [], { detectors: [{ id: 'two' }] }));
  assert.deepStrictEqual(r.items, [{ kind: 'detector_removed', values: ['one'] }]);
});

test('describeChange: singular and plural, wildcard, more, and every kind', () => {
  const one = describeChange({ from: 1, to: 2, at: '2026-01-01T00:00:00Z', count: 1, items: [{ kind: 'block_removed', secret: 'A' }], more: 0 });
  assert.deepStrictEqual(one, [
    'version 1 to 2 (2026-01-01T00:00:00Z) removed or loosened 1 restriction:',
    '  - secret A is no longer blocked',
  ]);
  const many = describeChange({ from: 1, to: 2, at: 'x', count: 0, items: [], more: 0 });
  assert.deepStrictEqual(many, ['version 1 to 2 (x) removed or loosened 0 restrictions:']);
  const lines = describeChange({
    from: 3, to: 4, at: 'x', count: 9, more: 2,
    items: [
      { kind: 'warn_removed', secret: '*' },
      { kind: 'hosts_widened', secret: 'A', values: ['a.example.com', 'b.example.com'] },
      { kind: 'commands_widened', secret: 'A', values: ['curl'] },
      { kind: 'placement_widened', secret: 'A', values: ['body'] },
      { kind: 'detector_removed', values: ['my_fmt', 'ignored'] },
      { kind: 'hosts_unlimited', secret: 'A' },
      { kind: 'unknown_kind', secret: 'A' },
    ],
  });
  assert.strictEqual(lines[0], 'version 3 to 4 (x) removed or loosened 9 restrictions:');
  assert.strictEqual(lines[1], '  - every secret no longer warns');
  assert.strictEqual(lines[2], '  - secret A may now go to more hosts: a.example.com, b.example.com');
  assert.strictEqual(lines[3], '  - secret A may now be used with more commands: curl');
  assert.strictEqual(lines[4], '  - secret A may now be put in more places in an HTTP request: body');
  assert.strictEqual(lines[5], '  - custom secret format my_fmt is no longer redacted');
  assert.strictEqual(lines[6], '  - secret A is no longer limited to a list of hosts');
  assert.strictEqual(lines[7], '  - ');
  assert.strictEqual(lines[8], '  - and 2 more');
});

test('describeChange throws on a missing change or missing items', () => {
  assert.throws(() => describeChange(undefined), TypeError);
  assert.throws(() => describeChange({ from: 1, to: 2, at: 'x', count: 1 }), TypeError);
});
