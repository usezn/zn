'use strict';
// The .NET profiler variables (COR_ENABLE_PROFILING=1 with COR_PROFILER and COR_PROFILER_PATH, and the CORECLR_ forms) make the runtime
// load a DLL into powershell.exe before the first line of a Windows hook script runs: the Windows twin of LD_PRELOAD. `zn audit` reports
// a project that turns one on for the agent as critical. The audit takes its code-loading variables from lib/loader-env.js, the list the
// launchers use, so the two cannot drift apart. Fixtures are inert.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { audit } = require('../lib/audit');
const P = require('../lib/audit/patterns');
const loaderEnv = require('../lib/loader-env');

function build(t, files) {
  const dir = tempDir(t, 'zn-audit-profiler-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const run = (dir) => audit({ root: dir, env: {} });
const ids = (res) => res.findings.map((f) => f.id + '/' + f.severity + '@' + f.file).join(', ');

test('classifyEnv: a .NET profiler turned on is its own kind; the profiler DLL settings load code', () => {
  for (const k of ['COR_ENABLE_PROFILING', 'CORECLR_ENABLE_PROFILING', 'cor_enable_profiling']) {
    assert.deepEqual(P.classifyEnv(k, '1'), { kind: 'profiler' }, k);
    assert.deepEqual(P.classifyEnv(k, ' 1 '), { kind: 'profiler' }, k + ' with spaces');
  }
  // The runtime acts only on 1.
  for (const v of ['0', 'true', '']) assert.notDeepEqual(P.classifyEnv('COR_ENABLE_PROFILING', v), { kind: 'profiler' }, JSON.stringify(v));
  for (const k of ['COR_PROFILER', 'COR_PROFILER_PATH', 'COR_PROFILER_PATH_64', 'CORECLR_PROFILER_PATH']) {
    assert.deepEqual(P.classifyEnv(k, 'C:\\example\\p.dll'), { kind: 'code' }, k);
  }
  assert.ok(loaderEnv.isProfilerOn('COR_ENABLE_PROFILING', '1'));
  assert.ok(!loaderEnv.isProfilerOn('COR_PROFILER', '1'));
});

test('classifyEnv: every code-loading name of loader-env.js is reported, the logging-only loader settings are not', () => {
  const names = [...new Set([...loaderEnv.LOADER_NAMES, ...loaderEnv.LOADER_PRELOAD, ...loaderEnv.LOADER_LIBPATH, ...loaderEnv.SH_UNSET_NAMES])];
  const logOnly = new Set(['LD_DEBUG', 'LD_DEBUG_OUTPUT', 'LD_SHOW_AUXV', 'LD_VERBOSE', 'LD_WARN', 'NODE_V8_COVERAGE', 'DYLD_PRINT_LIBRARIES']);
  for (const n of names) {
    if (logOnly.has(n) || n.startsWith('LD_TRACE_LOADED_OBJECTS')) continue;
    // NODE_OPTIONS counts only with a flag that loads code (tested in audit.test.js).
    const v = n === 'NODE_OPTIONS' ? '--require ./x.js' : '/example/x';
    assert.deepEqual(P.classifyEnv(n, v), { kind: 'code' }, n);
  }
  // The names the review found missing before.
  for (const n of ['NODE_PATH', 'GCONV_PATH', 'GLIBC_TUNABLES', 'OPENSSL_CONF', 'PYTHONPATH', 'PERLLIB', 'RUBYLIB', 'LD_PROFILE']) {
    assert.deepEqual(P.classifyEnv(n, '/example/x'), { kind: 'code' }, n);
  }
  // Any other LD_ or DYLD_ name loads or moves code too.
  assert.deepEqual(P.classifyEnv('LD_BIND_NOW', '1'), { kind: 'code' });
  assert.deepEqual(P.classifyEnv('DYLD_ROOT_PATH', '/example'), { kind: 'code' });
  // Only logging: not reported as loading code.
  for (const n of ['LD_DEBUG_OUTPUT', 'LD_SHOW_AUXV', 'NODE_V8_COVERAGE']) assert.equal(P.classifyEnv(n, '/example/x'), null, n);
  assert.equal(P.classifyEnv('LD_DEBUG', 'libs'), null);
});

test('Claude Code project settings that turn on a .NET profiler are critical', (t) => {
  const r = run(build(t, { '.claude/settings.json': JSON.stringify({ env: { COR_ENABLE_PROFILING: '1', COR_PROFILER: '{00000000-0000-0000-0000-000000000000}', COR_PROFILER_PATH: 'C:\\example\\p.dll' } }, null, 2) }));
  const crit = r.findings.filter((f) => f.id === 'ZNA008' && f.severity === 'critical' && f.file === '.claude/settings.json');
  assert.equal(crit.length, 1, ids(r));
  assert.match(crit[0].detail, /COR_ENABLE_PROFILING turns on a \.NET profiler/);
  assert.match(crit[0].detail, /PowerShell before any line of a zn hook runs/);
  // The profiler DLL settings next to it are code loading (high).
  assert.ok(r.findings.some((f) => f.id === 'ZNA008' && f.severity === 'high' && /COR_PROFILER_PATH/.test(f.detail)), ids(r));
});

test('a committed .env that turns on a .NET profiler is critical; set to 0 it is not', (t) => {
  const on = run(build(t, { '.env': 'FOO=1\nCOR_ENABLE_PROFILING=1\n' }));
  assert.ok(on.findings.some((f) => f.id === 'ZNA008' && f.severity === 'critical' && /COR_ENABLE_PROFILING/.test(f.detail)), ids(on));
  const off = run(build(t, { '.env': 'FOO=1\nCOR_ENABLE_PROFILING=0\n' }));
  assert.ok(!off.findings.some((f) => f.id === 'ZNA008' && f.severity === 'critical'), ids(off));
});

test('in the env of one MCP server a .NET profiler loads code into that server (high), not a hook finding', (t) => {
  const r = run(build(t, { '.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'], env: { COR_ENABLE_PROFILING: '1' } } } }, null, 2) }));
  const f = r.findings.filter((x) => x.id === 'ZNA008' && x.file === '.mcp.json');
  assert.equal(f.length, 1, ids(r));
  assert.equal(f[0].severity, 'high');
  assert.match(f[0].detail, /MCP server "demo"/);
});
