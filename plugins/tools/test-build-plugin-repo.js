#!/usr/bin/env node
'use strict';

/**
 * Tests for plugins/tools/build-plugin-repo.js with small synthetic zn-gate
 * tarballs. No network (the tests pass the integrity to build()).
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
const CLAUDE_DIR = path.resolve(__dirname, '..', 'claude-dir');
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-build-plugin-')));

/**
 * A gzipped ustar archive with the given {path: content} under package/.
 * A content of {type, body, raw} writes that entry type, and with raw: true
 * the name as given (without package/).
 */
function tgz(entries) {
  const blocks = [];
  for (const [rel, content] of Object.entries(entries)) {
    const spec = content && typeof content === 'object' && !Buffer.isBuffer(content) ? content : { body: content };
    const body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body || '');
    const h = Buffer.alloc(512);
    h.write((spec.raw ? '' : 'package/') + rel, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(spec.type || '0', 156);
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

/** One PAX extended header record; its length field counts bytes, itself included. */
function paxRecord(key, value) {
  const rest = ' ' + key + '=' + value + '\n';
  const restBytes = Buffer.byteLength(rest);
  let len = restBytes + 1;
  while (String(len).length + restBytes !== len) len = String(len).length + restBytes;
  return Buffer.from(len + rest);
}

function sri(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

const BASE = {
  'package.json': JSON.stringify({ name: 'zn-gate', version: VERSION, main: 'lib/index.js' }),
  'lib/index.js': "const dep = require('dep');\nconst sub = require('./sub');\nmodule.exports = { dep, sub, fs: require('node:fs') };\n",
  'lib/sub.js': "/**\n * Example: import { x } from 'not-bundled';\n */\n// require('also-not-bundled')\nmodule.exports = 'sub';\n",
  'lib/types.d.ts': 'export declare const x: number;\n',
  'lib/src.ts': 'export const y = 1;\n',
  'lib/src.mts': 'export const y = 1;\n',
  'lib/src.cts': 'export const y = 1;\n',
  'lib/index.js.map': '{"version":3}\n',
  'lib/data.json': '{"ok":true}\n',
  'lib/hooks/runner.js': 'module.exports = {};\n',
  'lib/broker/mcp.js': 'module.exports = {};\n',
  'lib/mcp.js': "import('esm-dep');\nmodule.exports = {};\n",
  'node_modules/dep/package.json': '{"name":"dep","main":"index.js"}',
  'node_modules/dep/index.js': "module.exports = 'dep';\n",
  'node_modules/dep/index.d.ts': 'export {};\n',
  'node_modules/esm-dep/package.json': '{"name":"esm-dep","type":"module","exports":{".":"./index.js","./sub/*":"./sub/*.js"}}',
  'node_modules/esm-dep/index.js': "/* import x from 'not-bundled'; */\nimport { a } from 'esm-dep/sub/a';\nexport { a };\n",
  'node_modules/esm-dep/sub/a.js': 'export const a = 1;\n',
};

let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  process.stdout.write('ok ' + n + ' - ' + name + '\n');
}

let builds = 0;
async function build(entries, opts = {}) {
  builds++;
  const file = path.join(tmp, 'zn-gate-' + builds + '.tgz');
  const archive = tgz(entries);
  fs.writeFileSync(file, archive);
  const out = opts.out || path.join(tmp, 'out-' + builds);
  const res = await builder.build({ tarball: file, out, integrity: opts.integrity || sri(archive) });
  return { res, out };
}

async function rejects(entries, re, opts) {
  await assert.rejects(build(entries, opts), re);
}

const esm = (code) => ({ ...BASE, 'node_modules/esm-dep/extra.js': code });

(async () => {
  try {
    await test('builds the plugin tree: plugin files unchanged, pruned bundle, lock, .gitattributes', async () => {
      const { res, out } = await build(BASE);
      assert.strictEqual(res.version, VERSION);
      for (const [rel, from] of builder.PLUGIN_FILES) {
        assert.ok(fs.readFileSync(path.join(out, rel)).equals(fs.readFileSync(path.join(from, rel))), rel);
      }
      for (const f of ['README.md', 'SECURITY.md', 'PROVENANCE.md']) {
        assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(CLAUDE_DIR, f))), f);
      }
      assert.strictEqual(fs.readFileSync(path.join(out, '.gitattributes'), 'utf8'), '* -text\n');
      const lock = JSON.parse(fs.readFileSync(path.join(out, 'scripts', 'zn-gate.lock.json'), 'utf8'));
      assert.strictEqual(lock.bundled, 'vendor/zn-gate');
      assert.strictEqual(lock.version, VERSION);
      const shipped = Object.keys(lock.files);
      assert.ok(!shipped.some((r) => /\.[mc]?ts$|\.map$/.test(r)), 'TypeScript sources, declarations and maps are pruned');
      assert.ok(shipped.includes('package.json') && shipped.includes('lib/data.json') && shipped.includes('node_modules/dep/package.json'));
      for (const rel of shipped) {
        const buf = fs.readFileSync(path.join(out, 'vendor', 'zn-gate', ...rel.split('/')));
        assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), lock.files[rel], rel);
      }
      for (const absent of ['package.json', 'package-lock.json', '.claude-plugin/marketplace.json', 'cursor', 'com.openai', 'mcp.json']) {
        assert.ok(!fs.existsSync(path.join(out, absent)), absent + ' is not shipped');
      }
    });

    await test('ES module imports (read with the Node.js parser) and import() must resolve inside the bundle', async () => {
      await rejects(esm('import{a}from"left-pad";\n'), /left-pad would be loaded from outside the bundle/);
      await rejects(esm("const q = /^\\/*/; import a from 'left-pad';\n"), /left-pad would be loaded from outside the bundle/);
      await rejects(esm('export*from"left-pad";\n'), /left-pad would be loaded from outside the bundle/);
      await rejects(esm("import 'esm-dep/missing';\n"), /esm-dep\/missing is not in the bundled esm-dep/);
      await rejects(esm("import './sub/a';\n"), /\.\/sub\/a is not in the bundle/); // ES modules name the file exactly
      await rejects(esm("import x from '../../../outside.js';\n"), /outside\.js is not in the bundle/);
      await rejects(esm('import x from ;\n'), /does not parse as an ES module/);
      // zn-gate has no "exports", so Node would not resolve zn-gate from inside it.
      await rejects(esm("import z from 'zn-gate';\n"), /zn-gate would be loaded from outside the bundle/);
      // import() in a CommonJS file goes to the Node loader too.
      await rejects({ ...BASE, 'lib/extra.js': "import('left-pad');\n" }, /left-pad would be loaded from outside the bundle/);
      await rejects({ ...BASE, 'lib/extra.js': 'const n = "x"; import(n);\n' }, /computed name cannot be checked/);
      await rejects({ ...BASE, 'lib/extra.js': "require('module').createRequire(__filename);\n" }, /createRequire/);
      // Comments between import and the parenthesis do not hide the call.
      await rejects({ ...BASE, 'lib/extra.js': "import /* c */ ('left-pad');\n" }, /left-pad would be loaded from outside the bundle/);
      await rejects({ ...BASE, 'lib/extra.js': "import // c\n('left-pad');\n" }, /left-pad would be loaded from outside the bundle/);
      // A parenthesis inside a string does not make a call look like a method definition.
      await rejects({ ...BASE, 'lib/extra.js': "import('left-pad' + ') {'.slice(3));\n" }, /computed name cannot be checked/);
      // Node's module system reached another way is refused.
      await rejects({ ...BASE, 'lib/extra.js': "process.mainModule.require('x');\n" }, /process\.mainModule/);
      await rejects({ ...BASE, 'lib/extra.js': "const M = require('node:module');\n" }, /"module" built-in/);
      await rejects(esm("import M from 'module';\n"), /"module" built-in/);
      // "exports": the first active condition decides; "require" alone does not serve import; no "../" targets.
      const pkgWith = (exportsField) => ({
        ...BASE,
        'node_modules/cond/package.json': JSON.stringify({ name: 'cond', type: 'module', exports: exportsField }),
        'node_modules/cond/ok.js': 'export const ok = 1;\n',
        'node_modules/esm-dep/extra.js': "import 'cond';\n",
      });
      await rejects(pkgWith({ default: './missing.js', import: './ok.js' }), /cond is not in the bundled cond/);
      await rejects(pkgWith({ require: './ok.js' }), /cond is not in the bundled cond/);
      await rejects(pkgWith('../esm-dep/index.js'), /cond is not in the bundled cond/);
      await build(pkgWith({ import: './ok.js', default: './missing.js' }));
      // A method named import is not a call; a call followed by a block on the next line is.
      await build(esm('const o = { async import(k, f) { return k; } };\nexport { o };\n'));
      await rejects({ ...BASE, 'lib/extra.js': 'const n = 1; import(n)\n{ }\n' }, /computed name cannot be checked/);
      // CommonJS require() is resolved by the launcher's own loader, inside the verified files only.
      await build({ ...BASE, 'lib/extra.js': "require('resolved-by-the-launcher');\n" });
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

    await test('unsafe or unsupported tarball entries are refused', async () => {
      await rejects({ ...BASE, '../evil.js': '' }, /unexpected path in tarball/);
      await rejects({ ...BASE, 'lib\\..\\..\\evil.js': '' }, /unexpected path in tarball/);
      await rejects({ ...BASE, 'c:evil.js': '' }, /unexpected path in tarball/);
      await rejects({ ...BASE, 'evil.js': { raw: true, body: '' } }, /unexpected path in tarball/);
      await rejects({ ...BASE, 'Lib/Index.js': '' }, /duplicate path in tarball/);
      await rejects({ ...BASE, 'lib/café.js': '', 'lib/café.js': '' }, /duplicate path in tarball/);
      await rejects({ ...BASE, 'lib/bad\u0007.js': '' }, /unexpected path in tarball/);
      // PAX headers: a path record is used for the next entry; a size record is refused.
      await rejects({ ...BASE, 'pax': { type: 'x', body: paxRecord('path', 'package/../evil-pax.js') }, 'lib/x.js': '' }, /unexpected path in tarball/);
      await rejects({ ...BASE, 'pax': { type: 'x', body: paxRecord('size', '12') }, 'lib/x.js': '' }, /PAX size records are not supported/);
      // Record lengths count bytes: a multi-byte name is read whole.
      await rejects({ ...BASE, 'pax': { type: 'x', body: paxRecord('path', 'package/lib/éé/../../../x.js') }, 'lib/x.js': '' }, /unexpected path in tarball/);
      await rejects({ ...BASE, 'lib/link.js': { type: '2', body: '' } }, /unsupported tar entry type "2"/);
      await rejects({ ...BASE, 'lib/hard.js': { type: '1', body: '' } }, /unsupported tar entry type "1"/);
    });

    await test('a truncated archive or a size that is not octal is refused', async () => {
      const archive = zlib.gunzipSync(tgz(BASE));
      const attempt = async (raw, re) => {
        const gz = zlib.gzipSync(raw);
        const file = path.join(tmp, 'raw-' + Math.random().toString(36).slice(2) + '.tgz');
        fs.writeFileSync(file, gz);
        await assert.rejects(builder.build({ tarball: file, out: path.join(tmp, 'out-raw'), integrity: sri(gz) }), re);
      };
      await attempt(archive.subarray(0, archive.length - 1024), /no end marker/);
      await attempt(archive.subarray(0, 512 + 10), /truncated tar entry/);
      const bad = Buffer.from(archive);
      bad.write('\x80\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 124, 'latin1'); // base-256 size
      await attempt(bad, /unsupported size field/);
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
