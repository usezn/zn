#!/usr/bin/env node
'use strict';

/**
 * Tests for plugins/tools/build-plugin-repo.js with small synthetic zn-gate
 * tarballs. No network (the integrity is passed with --integrity).
 *
 *   node plugins/tools/test-build-plugin-repo.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const builder = require('./build-plugin-repo');

const PLUGIN = path.resolve(__dirname, '..', 'zn-gate');
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-build-plugin-')));

/** A gzipped ustar archive with the given {path: content} under package/. */
function tgz(entries) {
  const blocks = [];
  for (const [rel, content] of Object.entries(entries)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write('package/' + rel, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function sri(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

const BASE = {
  'package.json': JSON.stringify({ name: 'zn-gate', version: VERSION, main: 'lib/index.js' }),
  'lib/index.js': "const dep = require('dep');\nconst sub = require('./sub');\nmodule.exports = { dep, sub, fs: require('node:fs') };\n",
  'lib/sub.js': "/**\n * Example: import { x } from 'not-bundled';\n */\n// require('also-not-bundled')\nmodule.exports = 'sub';\n",
  'lib/types.d.ts': 'export declare const x: number;\n',
  'lib/index.js.map': '{"version":3}\n',
  'lib/data.json': '{"ok":true}\n',
  'lib/hooks/runner.js': "module.exports = {};\n",
  'lib/broker/mcp.js': "module.exports = {};\n",
  'lib/mcp.js': "import('esm-dep');\nmodule.exports = {};\n",
  'node_modules/dep/package.json': '{"name":"dep","main":"index.js"}',
  'node_modules/dep/index.js': "module.exports = 'dep';\n",
  'node_modules/dep/index.d.ts': 'export {};\n',
  'node_modules/esm-dep/package.json': '{"name":"esm-dep","type":"module","exports":{".":"./index.js","./sub/*":"./sub/*.js"}}',
  'node_modules/esm-dep/index.js': "import { a } from 'esm-dep/sub/a';\nexport { a };\n",
  'node_modules/esm-dep/sub/a.js': 'export const a = 1;\n',
};

let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  process.stdout.write('ok ' + n + ' - ' + name + '\n');
}

async function build(entries, opts = {}) {
  const file = path.join(tmp, 'zn-gate-' + n + '.tgz');
  const archive = tgz(entries);
  fs.writeFileSync(file, archive);
  const out = opts.out || path.join(tmp, 'out-' + n + '-' + Math.random().toString(36).slice(2));
  const res = await builder.build({ tarball: file, out, integrity: opts.integrity || sri(archive) });
  return { res, out };
}

async function rejects(entries, re, opts) {
  await assert.rejects(build(entries, opts), re);
}

(async () => {
  try {
    await test('builds the plugin tree: plugin files unchanged, pruned bundle, lock, .gitattributes', async () => {
      const { res, out } = await build(BASE);
      assert.strictEqual(res.version, VERSION);
      for (const rel of builder.PLUGIN_FILES) {
        assert.ok(fs.readFileSync(path.join(out, rel)).equals(fs.readFileSync(path.join(PLUGIN, rel))), rel);
      }
      assert.strictEqual(fs.readFileSync(path.join(out, '.gitattributes'), 'utf8'), '* -text\n');
      const lock = JSON.parse(fs.readFileSync(path.join(out, 'scripts', 'zn-gate.lock.json'), 'utf8'));
      assert.strictEqual(lock.bundled, 'vendor/zn-gate');
      assert.strictEqual(lock.version, VERSION);
      const shipped = Object.keys(lock.files);
      assert.ok(!shipped.some((r) => /\.d\.ts$|\.map$/.test(r)), 'types and maps are pruned');
      assert.ok(shipped.includes('package.json') && shipped.includes('lib/data.json') && shipped.includes('node_modules/dep/package.json'));
      for (const rel of shipped) {
        const buf = fs.readFileSync(path.join(out, 'vendor', 'zn-gate', ...rel.split('/')));
        assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), lock.files[rel], rel);
      }
      assert.ok(!fs.existsSync(path.join(out, 'package.json')) && !fs.existsSync(path.join(out, 'package-lock.json')), 'no npm files');
      assert.ok(!fs.existsSync(path.join(out, '.claude-plugin', 'marketplace.json')), 'no marketplace in the plugin repo');
    });

    await test('imports in comments are ignored; real imports must resolve inside the bundle', async () => {
      await rejects({ ...BASE, 'lib/extra.js': "require('left-pad');\n" }, /left-pad would be loaded from outside the bundle/);
      await rejects({ ...BASE, 'lib/extra.js': "import x from 'esm-dep/missing';\n" }, /esm-dep\/missing is not in the bundled esm-dep/);
      await rejects({ ...BASE, 'lib/extra.js': "require('./nope');\n" }, /\.\/nope is not in the bundle/);
      await rejects({ ...BASE, 'lib/extra.js': "require('../../../outside');\n" }, /outside is not in the bundle/);
      const s = builder.specifiers("const u = 'http://x//y'; require('a'); /* require('b') */ `${'//'}`; import('c');");
      assert.deepStrictEqual([...s].sort(), ['a', 'c']);
    });

    await test('the tarball must match the integrity', async () => {
      await rejects(BASE, /integrity mismatch/, { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') });
    });

    await test('the tarball version must be the one the plugin is pinned to', async () => {
      await rejects({ ...BASE, 'package.json': JSON.stringify({ name: 'zn-gate', version: '0.0.1' }) }, /run pin-release\.js first/);
      await rejects({ ...BASE, 'package.json': JSON.stringify({ name: 'other', version: VERSION }) }, /not a zn-gate release tarball/);
    });

    await test('the launcher files must be in the tarball', async () => {
      const entries = { ...BASE };
      delete entries['lib/mcp.js'];
      await rejects(entries, /lacks lib\/mcp\.js/);
    });

    await test('directory limits: file size and count', async () => {
      await rejects({ ...BASE, 'lib/big.js': 'x'.repeat(256 * 1024) }, /lib\/big\.js is 262144 bytes \(256 KiB or more\)/);
      const many = { ...BASE };
      for (let i = 0; i < 520; i++) many['lib/m/' + i + '.js'] = '';
      await rejects(many, /files \(the limit is 512\)/);
    });

    await test('unsafe tarball paths are refused', async () => {
      await rejects({ ...BASE, '../evil.js': '' }, /unexpected path in tarball/);
    });

    await test('the output folder must be empty (a .git folder is allowed)', async () => {
      const out = path.join(tmp, 'busy');
      fs.mkdirSync(path.join(out, '.git'), { recursive: true });
      await build(BASE, { out });
      await rejects(BASE, /is not empty/, { out });
    });

    process.stdout.write('1..' + n + '\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  process.stderr.write((err && err.stack) || String(err));
  process.stderr.write('\n');
  process.exitCode = 1;
});
