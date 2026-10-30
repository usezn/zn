'use strict';

process.env.ZN_STATS = 'off';

// Scope guard: a tool call is checked against a written scope, deny by default. Nothing here runs a command or opens
// a connection: the tools are inert, the guard only reads text. Targets are reserved names and documentation
// addresses (example.com, example.org, example.net, *.test, *.invalid, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const guard = require('../lib/scope/guard');
const evidence = require('../lib/evidence');
const runner = require('../lib/hooks/runner');
const realEngine = require('../lib/scrub/engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

const BASE = {
  version: 1,
  targets: {
    hosts: ['app.example.com', '*.lab.test'],
    cidrs: ['192.0.2.0/24'],
    url_prefixes: ['https://api.example.org/v1/'],
    mcp_servers: ['lab-notes'],
  },
  rules: { allowed_tools: ['bash', 'webfetch', 'powershell'], allowed_mcp_tools: ['lab-notes/search'] },
};

function setup(t, patch = {}) {
  const dir = tempDir(t, 'zn-scope-');
  const doc = JSON.parse(JSON.stringify(BASE));
  if (patch.rules) Object.assign(doc.rules, patch.rules);
  if (patch.targets) Object.assign(doc.targets, patch.targets);
  const file = path.join(dir, 'scope.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  const opts = { scopeFile: file, home: dir, scopeState: path.join(dir, 'state.json'), agentId: 'claude-code' };
  const bash = (command, extra = {}) => guard.decide({ event: 'pre_tool', tool: 'bash', cwd: dir, input: { command } }, { ...opts, ...extra });
  return { dir, file, opts, bash };
}

const inScope = (r) => assert.equal(r, null);
function refused(r, code) {
  assert.ok(r, 'expected a refusal');
  assert.equal(r.decision, 'deny');
  assert.equal(r.scopeRefusal, code, r.message);
  assert.match(r.message, /out of scope/);
}

/* ------------------------------- in scope ------------------------------- */

test('in-scope calls are not refused', (t) => {
  const { bash, opts, dir } = setup(t);
  inScope(bash('curl -s https://app.example.com/status'));
  inScope(bash('curl http://192.0.2.10:8080/health'));
  inScope(bash('curl https://api.example.org/v1/items?id=3'));
  inScope(bash('wget --max-redirect=0 https://x.lab.test/a'));
  inScope(bash('ls -la && echo done'));
  inScope(bash('curl http://localhost:3000/')); // never leaves the computer
  inScope(guard.decide({ event: 'pre_tool', tool: 'webfetch', cwd: dir, input: { url: 'https://deep.sub.lab.test/p' } }, opts));
});

test('numeric spellings of an address are read as the address', (t) => {
  const { bash } = setup(t);
  inScope(bash('curl http://0xC0000201/'));    // 192.0.2.1
  inScope(bash('curl http://3221225985/'));    // 192.0.2.1
  refused(bash('curl http://0xC6336407/'), 'target'); // 198.51.100.7
  refused(bash('curl http://3325256711/'), 'target'); // 198.51.100.7
});

/* ------------------------------- out of scope ------------------------------- */

test('a host, an address or a CIDR outside the scope is refused', (t) => {
  const { bash } = setup(t);
  refused(bash('curl https://other.example.net/'), 'target');
  refused(bash('curl http://198.51.100.7/'), 'target');
  refused(bash('curl http://203.0.113.9:81/'), 'target');
  refused(bash('wget --max-redirect=0 https://lab.test/'), 'target');           // the wildcard does not cover the bare domain
  refused(bash('curl https://x.lab.test.invalid/'), 'target');                   // suffix trick
  refused(bash('curl https://app.example.com.example.net/'), 'target');
  inScope(bash('nmap 192.0.2.0/28'));
  refused(bash('nmap 192.0.2.0/23'), 'target');                                  // wider than the allowed block
  refused(bash('nmap 198.51.100.0/24'), 'target');
  refused(bash('ssh user@203.0.113.5'), 'target');
  inScope(bash('ssh user@192.0.2.20'));
  refused(bash('git clone https://other.example.net/r.git'), 'target');
});

test('user information, a path and the API prefix cannot be used to move the host or the path', (t) => {
  const { bash } = setup(t);
  refused(bash('curl https://app.example.com@other.example.net/'), 'target');
  refused(bash('curl https://api.example.org/v1/../admin'), 'target');
  refused(bash('curl https://api.example.org/v10/x'), 'target');
  refused(bash('curl https://api.example.org/other'), 'target');
});

test('another host in a parameter, plain or percent-encoded, is refused', (t) => {
  const { bash } = setup(t);
  refused(bash('curl "https://app.example.com/redir?next=https://other.example.net/"'), 'target');
  refused(bash('curl "https://app.example.com/redir?next=https%3A%2F%2Fother.example.net%2F"'), 'target');
  refused(bash('curl "https://app.example.com/redir?to=//other.example.net/x"'), 'target');
  refused(bash('curl -H "X-Forward: 203.0.113.4" https://app.example.com/'), 'target');
});

test('known gap: a bare host name in a parameter, without a scheme, is not read', (t) => {
  const { bash } = setup(t);
  inScope(bash('curl "https://app.example.com/redir?host=other.example.net"'));
});

test('tools and MCP servers outside the scope are refused', (t) => {
  const { opts, dir } = setup(t);
  const call = (tool, input, mcp) => guard.decide({ event: 'pre_tool', tool, cwd: dir, input, mcp }, opts);
  refused(call('write', { path: 'a.txt' }), 'tool');
  refused(call('websearch', { query: 'x' }), 'tool');
  inScope(call('mcp', { args: { q: 'notes' } }, { server: 'lab-notes', tool: 'search' }));
  refused(call('mcp', { args: { q: 'notes' } }, { server: 'other-server', tool: 'search' }), 'mcp-server');
  refused(call('mcp', { args: {} }, { server: 'lab-notes', tool: 'delete' }), 'mcp-tool');
  refused(call('mcp', { args: { url: 'https://other.example.net/' } }, { server: 'lab-notes', tool: 'search' }), 'target');
  refused(call('mcp', {}, undefined), 'mcp-server');
  refused(call('webfetch', { url: 'https://other.example.net/' }), 'target');
});

/* ------------------------------- unresolved ------------------------------- */

test('a target built at run time is unresolved: denied, or asked with rules.unresolved = ask', (t) => {
  const { bash } = setup(t);
  for (const cmd of ['curl "$URL"', 'curl https://$HOST/x', 'curl "$(cat target.txt)"', 'echo run | sh', 'bash < steps.txt', 'wget', 'ssh "$H"', 'git push']) {
    refused(bash(cmd), 'unresolved');
  }
  const ask = setup(t, { rules: { unresolved: 'ask' } });
  const r = ask.bash('curl "$URL"');
  assert.equal(r.decision, 'ask');
});

test('a redirect that a program would follow is unresolved unless the scope allows it', (t) => {
  const { bash } = setup(t);
  refused(bash('curl -L https://app.example.com/'), 'unresolved');
  refused(bash('curl -sSLf https://app.example.com/'), 'unresolved');
  refused(bash('curl --location https://app.example.com/'), 'unresolved');
  refused(bash('wget https://app.example.com/'), 'unresolved');
  inScope(bash('curl -s https://app.example.com/'));
  const open = setup(t, { rules: { follow_redirects: true } });
  inScope(open.bash('curl -L https://app.example.com/'));
});

test('shell code inside sh -c is checked as a command', (t) => {
  const { bash } = setup(t);
  refused(bash("sh -c 'curl https://other.example.net/'"), 'target');
  inScope(bash("bash -c 'curl -s https://app.example.com/'"));
  refused(bash("bash -c 'curl \"$U\"'"), 'unresolved');
});

/* ------------------------------- scripts ------------------------------- */

test('a script the agent runs by path is read once, one level, and judged by what it names', (t) => {
  const { bash, dir } = setup(t);
  const w = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  w('ok.py', 'import requests\nrequests.get("https://app.example.com/status")\n');
  w('out.py', 'import requests\nrequests.get("https://other.example.net/x")\n');
  w('mixed.js', 'fetch("https://app.example.com/a");\nfetch("https://other.example.net/b");\n');
  w('plain.py', 'print("hello")\nvalue = 1 + 2\n');
  w('env.py', 'import os, requests\nrequests.get(os.environ["TARGET"])\n');
  w('fmt.py', 'import requests\nhost = "app.example.com"\nrequests.get(f"https://{host}/x")\n');
  w('plus.js', 'const u = "https://app." + "example.com/";\nfetch(u);\n');
  w('noname.py', 'import socket\ns = socket.socket()\n');
  w('b64.py', 'import base64, requests\nrequests.get(base64.b64decode("aHR0cHM6Ly9hcHAuZXhhbXBsZS5jb20v"))\n');
  w('run.sh', '#!/bin/sh\ncurl -s https://app.example.com/ok\n');
  w('runout.sh', '#!/bin/sh\ncurl -s http://198.51.100.9/x\n');
  w('rundyn.sh', '#!/bin/sh\ncurl -s "$1"\n');
  fs.writeFileSync(path.join(dir, 'tool.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
  inScope(bash('python3 ok.py'));
  refused(bash('python3 out.py'), 'target');
  refused(bash('node mixed.js'), 'target');
  inScope(bash('python3 plain.py'));
  refused(bash('python3 env.py'), 'unresolved');
  refused(bash('python3 fmt.py'), 'unresolved');
  refused(bash('node plus.js'), 'unresolved');
  refused(bash('python3 noname.py'), 'unresolved');
  refused(bash('python3 b64.py'), 'unresolved');
  inScope(bash('bash run.sh'));
  refused(bash('sh runout.sh'), 'target');
  refused(bash('./rundyn.sh https://app.example.com/'), 'unresolved'); // the argument is not read: the script takes its target from outside
  refused(bash('python3 missing.py'), 'unresolved');
  refused(bash('./tool.bin'), 'unresolved');
  refused(bash('python3 -m http.server'), 'unresolved');
});

test('known gap: an import or a sourced file is not followed, so a script that only calls it passes the guard', (t) => {
  const { bash, dir } = setup(t);
  fs.writeFileSync(path.join(dir, 'helper.py'), 'import requests\nrequests.get("https://other.example.net/")\n');
  fs.writeFileSync(path.join(dir, 'wrapper.py'), 'import helper\nhelper.run()\n');
  inScope(bash('python3 wrapper.py'));
  refused(bash('python3 helper.py'), 'target');
});

test('inline code and here-documents are read as scripts', (t) => {
  const { bash } = setup(t);
  refused(bash('python3 -c "import urllib.request as u; u.urlopen(\'https://other.example.net/\')"'), 'target');
  inScope(bash('python3 -c "import urllib.request as u; u.urlopen(\'https://app.example.com/\')"'));
  refused(bash('python3 - <<EOF\nimport requests\nrequests.get("https://other.example.net/")\nEOF'), 'target');
  inScope(bash('python3 - <<EOF\nimport requests\nrequests.get("https://app.example.com/")\nEOF'));
});

/* ------------------------------- the scope file ------------------------------- */

test('a malformed, missing or unreadable scope file refuses every tool call', (t) => {
  const { dir, opts } = setup(t);
  const any = [['bash', { command: 'ls' }], ['read', { path: 'a.txt' }], ['webfetch', { url: 'https://app.example.com/' }], ['mcp', { args: {} }, { server: 'lab-notes', tool: 'search' }]];
  const bad = {
    'not json': '{ nope',
    array: '[]',
    'unknown key': JSON.stringify({ ...BASE, extra: 1 }),
    'unknown rule': JSON.stringify({ ...BASE, rules: { ...BASE.rules, allow_all: true } }),
    'bad version': JSON.stringify({ ...BASE, version: 2 }),
    'no targets': JSON.stringify({ version: 1, targets: {}, rules: { allowed_tools: ['bash'] } }),
    'bad cidr': JSON.stringify({ ...BASE, targets: { ...BASE.targets, cidrs: ['192.0.2.0/99'] } }),
    'bad host': JSON.stringify({ ...BASE, targets: { ...BASE.targets, hosts: ['*'] } }),
    'bad window': JSON.stringify({ ...BASE, rules: { ...BASE.rules, time_window: { not_before: 'x', not_after: 'y' } } }),
    'bad limit': JSON.stringify({ ...BASE, rules: { ...BASE.rules, max_requests: -1 } }),
    'bad unresolved': JSON.stringify({ ...BASE, rules: { ...BASE.rules, unresolved: 'allow' } }),
    empty: '',
  };
  for (const [name, body] of Object.entries(bad)) {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, body);
    for (const [tool, input, mcp] of any) refused(guard.decide({ event: 'pre_tool', tool, cwd: dir, input, mcp }, { ...opts, scopeFile: file }), 'scope-file');
    assert.equal(guard.loadScope(file).ok, false, name);
  }
  refused(guard.decide({ event: 'pre_tool', tool: 'bash', cwd: dir, input: { command: 'ls' } }, { ...opts, scopeFile: path.join(dir, 'absent.json') }), 'scope-file');
});

test('a pinned hash that does not match refuses every call', (t) => {
  const { bash, file } = setup(t);
  const sha = guard.loadScope(file).sha256;
  inScope(bash('ls', { scopeSha256: sha }));
  refused(bash('ls', { scopeSha256: '0'.repeat(64) }), 'scope-file');
});

test('the time window and the request limit are enforced', (t) => {
  const win = setup(t, { rules: { time_window: { not_before: '2026-11-01T00:00:00Z', not_after: '2026-11-02T00:00:00Z' } } });
  refused(win.bash('ls', { now: Date.parse('2026-10-31T23:59:59Z') }), 'time-window');
  inScope(win.bash('ls', { now: Date.parse('2026-11-01T12:00:00Z') }));
  refused(win.bash('ls', { now: Date.parse('2026-11-02T00:00:01Z') }), 'time-window');

  const lim = setup(t, { rules: { max_requests: 2 } });
  inScope(lim.bash('curl -s https://app.example.com/1'));
  inScope(lim.bash('ls'));                                                       // not a request: not counted
  inScope(lim.bash('curl -s https://app.example.com/2'));
  refused(lim.bash('curl -s https://app.example.com/3'), 'max-requests');
  // a different scope file starts a new count
  fs.writeFileSync(lim.file, JSON.stringify({ ...BASE, rules: { ...BASE.rules, max_requests: 3 } }));
  inScope(lim.bash('curl -s https://app.example.com/4'));
});

/* ------------------------------- evidence ------------------------------- */

test('each refusal is an evidence event that names the hash of the scope file, and verify() checks it', (t) => {
  const { bash, dir, file } = setup(t);
  const ledger = path.join(dir, '.zn', 'evidence.jsonl');
  const sha = guard.loadScope(file).sha256;
  refused(bash('curl https://other.example.net/'), 'target');
  refused(bash('curl "$X"'), 'unresolved');
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const r of lines) {
    assert.equal(r.phase, 'scope-guard');
    assert.equal(r.verdict, 'block');
    assert.equal(r.engine, 'zn-scope-guard');
    assert.match(r.reason, new RegExp('scope_sha256=' + sha));
  }
  assert.equal(lines[0].rule, 'scope-target');
  assert.equal(lines[1].rule, 'scope-unresolved');
  assert.equal(evidence.verifyEvidenceLedger(ledger).valid, true);
  assert.deepEqual(guard.verify(file, ledger), { scopeSha256: sha, valid: true, events: 2, matching: 2, others: [] });
  // the scope file changes: the old events no longer match the file in force
  fs.writeFileSync(file, JSON.stringify({ ...BASE, rules: { ...BASE.rules, max_requests: 9 } }));
  const after = guard.verify(file, ledger);
  assert.equal(after.matching, 0);
  assert.deepEqual(after.others, [sha]);
  // the log never holds the text of the command
  assert.ok(!fs.readFileSync(ledger, 'utf8').includes('"$X"'));
});

/* ------------------------------- the policy engine hook ------------------------------- */

test('the hook runs in the pre-tool decision only when a scope file is configured', async (t) => {
  const { dir, file } = setup(t);
  const d = { engine: () => realEngine, vault: async () => createFakeVault(), detectors: () => [] };
  const ev = (command) => ({ event: 'pre_tool', tool: 'bash', toolName: 'Bash', cwd: dir, input: { command } });
  const base = { failMode: 'open', egressCheck: 'off', home: dir };
  const off = await runner.decidePre(ev('curl https://other.example.net/'), d, 'claude-code', base);
  assert.equal(off.decision, 'allow');
  const on = await runner.decidePre(ev('curl https://other.example.net/'), d, 'claude-code', { ...base, scopeFile: file });
  assert.equal(on.decision, 'deny');
  assert.match(on.message, /out of scope/);
  const fine = await runner.decidePre(ev('ls'), d, 'claude-code', { ...base, scopeFile: file });
  assert.equal(fine.decision, 'allow');
  // the same through ~/.zn/config.json
  fs.mkdirSync(path.join(dir, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zn', 'config.json'), JSON.stringify({ hooks: { scopeFile: file } }));
  const viaConfig = await runner.decidePre(ev('curl https://other.example.net/'), d, 'claude-code', base);
  assert.equal(viaConfig.decision, 'deny');
});
