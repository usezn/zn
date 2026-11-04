'use strict';
// `zn-gate scan --package NAME[@VERSION]`: the package comes from a local registry stub (no network), its
// tarballs are fictitious fixtures, and a marker proves that nothing in a package is ever run.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'scan-package');
const { parsePackageSpec, extractTarball, PackageError } = require('../lib/scan-package');

// A minimal ustar entry, to build the hostile archives below (a link, a path that leaves the folder).
function tarEntry(name, body, type = '0', linkname = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}

function tgz(parts) {
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function integrityOf(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

// Registry stub: GET /<name>/<version or tag> returns the version document, GET /-/<file> the tarball.
function startRegistry() {
  const clean = fs.readFileSync(path.join(FIXTURES, 'zn-fixture-clean-1.0.0.tgz'));
  const injected = fs.readFileSync(path.join(FIXTURES, 'zn-fixture-injected-1.0.0.tgz'));
  const marker = 'node -e "require(\'fs\').writeFileSync(process.env.ZN_TEST_MARKER,\'ran\')"';
  const linked = tgz([
    tarEntry('package/package.json', Buffer.from(JSON.stringify({ name: 'zn-fixture-linked', version: '1.0.0', scripts: { postinstall: marker } }))),
    tarEntry('package/link.md', Buffer.alloc(0), '2', '/etc/hostname'),
  ]);
  const escaping = tgz([
    tarEntry('package/package.json', Buffer.from(JSON.stringify({ name: 'zn-fixture-escape', version: '1.0.0' }))),
    tarEntry('package/../../zn-fixture-escaped.txt', Buffer.from('outside the folder\n')),
  ]);
  const tarballs = {
    'zn-fixture-clean-1.0.0.tgz': clean,
    'zn-fixture-injected-1.0.0.tgz': injected,
    'zn-fixture-linked-1.0.0.tgz': linked,
    'zn-fixture-escape-1.0.0.tgz': escaping,
  };
  const docs = {
    'zn-fixture-clean': { version: '1.0.0', file: 'zn-fixture-clean-1.0.0.tgz', buf: clean },
    'zn-fixture-injected': { version: '1.0.0', file: 'zn-fixture-injected-1.0.0.tgz', buf: injected },
    'zn-fixture-linked': { version: '1.0.0', file: 'zn-fixture-linked-1.0.0.tgz', buf: linked },
    'zn-fixture-escape': { version: '1.0.0', file: 'zn-fixture-escape-1.0.0.tgz', buf: escaping },
    // The registry gives a checksum that does not match the tarball.
    'zn-fixture-badsum': { version: '1.0.0', file: 'zn-fixture-clean-1.0.0.tgz', buf: clean, integrity: integrityOf(injected) },
    // The registry gives no checksum at all.
    'zn-fixture-nosum': { version: '1.0.0', file: 'zn-fixture-clean-1.0.0.tgz', buf: clean, noSum: true },
  };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/-/')) {
      const buf = tarballs[url.slice(3)];
      if (!buf) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(buf);
      return;
    }
    const m = /^\/([^/]+)\/([^/]+)$/.exec(url);
    const doc = m && docs[m[1]];
    if (!doc || (m[2] !== '1.0.0' && m[2] !== 'latest')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"Not found"}');
      return;
    }
    const base = 'http://127.0.0.1:' + server.address().port;
    const dist = { tarball: base + '/-/' + doc.file };
    if (!doc.noSum) dist.integrity = doc.integrity || integrityOf(doc.buf);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: m[1], version: doc.version, dist }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Runs the CLI asynchronously (the registry stub lives in this process).
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ZN_LOCAL_ONLY: 'true', NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-pkg-test-'));
  return { dir, marker: path.join(dir, 'marker.txt'), tmp: path.join(dir, 'tmp') };
}

async function withRegistry(fn) {
  const server = await startRegistry();
  const base = 'http://127.0.0.1:' + server.address().port;
  const box = sandbox();
  fs.mkdirSync(box.tmp);
  try {
    return await fn({ base, box });
  } finally {
    server.close();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
}

function envFor(base, box) {
  return { ZN_NPM_REGISTRY: base, ZN_TEST_MARKER: box.marker, TMPDIR: box.tmp, TEMP: box.tmp, TMP: box.tmp };
}

test('a clean package passes, and its postinstall script never runs', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-clean@1.0.0'], envFor(base, box));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Target\s*: npm zn-fixture-clean@1\.0\.0/);
    assert.match(r.stdout, /PASSED - NO THREATS DETECTED/);
    assert.match(r.stdout, /Config audit: no findings/);
    assert.ok(!fs.existsSync(box.marker), 'the package code ran');
    assert.deepStrictEqual(fs.readdirSync(box.tmp), [], 'the temporary folder was not removed');
  });
});

test('a package whose tool description asks the model to read a secret file fails with exit 1', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-injected'], envFor(base, box));
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /THREAT\(S\) FOUND/);
    assert.match(r.stdout, /index\.js:\d+ Threat/);
    assert.match(r.stdout, /path:sensitive_file/);
    assert.ok(!fs.existsSync(box.marker), 'the package code ran');
    assert.deepStrictEqual(fs.readdirSync(box.tmp), [], 'the temporary folder was not removed');
  });
});

test('an unreachable registry exits 2, not 1 (findings), and says nothing was scanned', async () => {
  await withRegistry(async ({ box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-clean'], envFor('http://127.0.0.1:9', box));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /could not reach the registry/);
    assert.match(r.stderr, /Nothing was scanned/);
    assert.strictEqual(r.stdout, '');
  });
});

test('an unknown package exits 2 with a clear message', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-missing'], envFor(base, box));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /zn-fixture-missing@latest was not found on the registry/);
  });
});

test('a tarball that does not match the registry checksum is refused', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-badsum@1.0.0'], envFor(base, box));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /does not match the checksum/);
    assert.strictEqual(r.stdout, '');
  });
});

test('a package with no checksum from the registry is refused', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-nosum@1.0.0'], envFor(base, box));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /no checksum/);
  });
});

test('a tarball with a link is refused and nothing in it is run', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-linked@1.0.0'], envFor(base, box));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /link or a special file/);
    assert.ok(!fs.existsSync(box.marker), 'the package code ran');
  });
});

test('a path that leaves the package folder is refused, and nothing is written outside it', async () => {
  await withRegistry(async ({ base, box }) => {
    const r = await runCli(['scan', '--package', 'zn-fixture-escape@1.0.0'], envFor(base, box));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /leaves its folder/);
    assert.ok(!fs.existsSync(path.join(box.dir, 'zn-fixture-escaped.txt')), 'a file was written outside the folder');
    assert.deepStrictEqual(fs.readdirSync(box.tmp), [], 'the temporary folder was not removed');
  });
});

test('usage errors exit 2 before any download', async () => {
  await withRegistry(async ({ base, box }) => {
    const env = envFor(base, box);
    const cases = [
      [['scan', '--package'], /needs an npm package name/],
      [['scan', '--package', 'Bad Name!'], /not an npm package name/],
      [['scan', '--package', 'zn-fixture-clean@'], /not a version or dist-tag|not an npm package name/],
      [['scan', '--package', 'zn-fixture-clean', '.'], /leave out the folder argument/],
      [['scan', '--package', 'zn-fixture-clean', '--format', 'json'], /supports only --format text/],
      [['scan', '--package', 'zn-fixture-clean', '--include-home'], /cannot be used with --package/],
    ];
    for (const [args, re] of cases) {
      const r = await runCli(args, env);
      assert.strictEqual(r.status, 2, args.join(' ') + '\n' + r.stderr);
      assert.match(r.stderr, re, args.join(' '));
    }
  });
});

test('a plain http registry is refused unless it is localhost', async () => {
  const r = await runCli(['scan', '--package', 'zn-fixture-clean'], { ZN_NPM_REGISTRY: 'http://registry.example.com' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /must be an https address/);
});

test('package specs: names, scopes and versions', () => {
  assert.deepStrictEqual(parsePackageSpec('zn-fixture-clean'), { name: 'zn-fixture-clean', version: 'latest' });
  assert.deepStrictEqual(parsePackageSpec('zn-fixture-clean@1.2.3'), { name: 'zn-fixture-clean', version: '1.2.3' });
  assert.deepStrictEqual(parsePackageSpec('@scope/tool@next'), { name: '@scope/tool', version: 'next' });
  assert.throws(() => parsePackageSpec('../etc'), PackageError);
  assert.throws(() => parsePackageSpec('a/b/c'), PackageError);
});

test('extractTarball writes only files and folders inside the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-extract-test-'));
  try {
    const good = fs.readFileSync(path.join(FIXTURES, 'zn-fixture-clean-1.0.0.tgz'));
    const r = extractTarball(good, dir);
    assert.ok(r.files >= 4);
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'add', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'package')), 'the npm folder prefix was kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
