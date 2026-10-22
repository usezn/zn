'use strict';
/*
 * A config file with a byte that is not valid UTF-8 (a Latin-1 e-acute inside
 * a JSON string) must be refused by `zn hooks install` and `uninstall`, and
 * left byte for byte as it was. Reading it as UTF-8 would turn the byte into
 * U+FFFD and write that back. Every path is inside a temporary fake home and
 * project; no real user config is read.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const cli = require('../lib/broker/cli');

const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'antigravity'];
const BAD = Buffer.concat([Buffer.from('{"note": "caf'), Buffer.from([0xe9]), Buffer.from('", "keep": true}\n')]);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sink = () => { let s = ''; return { write: (x) => { s += x; }, get text() { return s; } }; };

async function zn(home, project, args) {
  const stdout = sink();
  const stderr = sink();
  const rc = await cli.dispatch('hooks', args, { cwd: project, home, env: {}, stdout, stderr, human: true });
  return { rc, out: stdout.text, err: stderr.text };
}

/* Where an agent keeps its config: install once in a scratch home and read the path from the report. */
async function configRel(t, agent, scope) {
  const home = tempDir(t, 'zn-utf8-probe-home-');
  const project = tempDir(t, 'zn-utf8-probe-proj-');
  const args = ['install', agent, '--no-mcp'].concat(scope === 'project' ? ['--project'] : []);
  const r = await zn(home, project, args);
  assert.equal(r.rc, 0, r.err);
  const m = /in (.+)\n/.exec(r.out);
  const file = m[1].trim();
  const base = scope === 'project' ? project : home;
  const rel = path.relative(base, file);
  assert.ok(!rel.startsWith('..'), file + ' is outside the fake ' + scope);
  return rel;
}

for (const agent of AGENTS) {
  for (const scope of ['user', 'project']) {
    for (const action of ['install', 'uninstall']) {
      test('hooks ' + action + ' ' + agent + ' (' + scope + '): invalid UTF-8 is refused, file unchanged', async (t) => {
        const rel = await configRel(t, agent, scope);
        const home = tempDir(t, 'zn-utf8-home-');
        const project = tempDir(t, 'zn-utf8-proj-');
        const file = path.join(scope === 'project' ? project : home, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, BAD);
        const before = sha(file);
        const args = [action, agent, '--no-mcp'].concat(scope === 'project' ? ['--project'] : []);
        const r = await zn(home, project, args);
        assert.equal(r.rc, 1, r.out + r.err);
        assert.match(r.err, /not valid UTF-8 \(left unchanged\)/);
        assert.ok(r.err.includes(file), r.err);
        assert.match(r.err, /Save the file as UTF-8/);
        assert.equal(sha(file), before);
        assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.bak-zn-')), []);
      });
    }
  }
}

for (const action of ['install', 'uninstall']) {
  test('hooks ' + action + ' claude-code --project: invalid UTF-8 in .mcp.json is refused, file unchanged', async (t) => {
    const home = tempDir(t, 'zn-utf8-home-');
    const project = tempDir(t, 'zn-utf8-proj-');
    const mcp = path.join(project, '.mcp.json');
    fs.writeFileSync(mcp, BAD);
    const before = sha(mcp);
    const r = await zn(home, project, [action, 'claude-code', '--project']);
    assert.equal(r.rc, 1, r.out + r.err);
    assert.match(r.err, /\.mcp\.json is not valid UTF-8 \(left unchanged\)/);
    assert.equal(sha(mcp), before);
  });
}

test('hooks install and uninstall still work on a file with a valid UTF-8 e-acute', async (t) => {
  for (const agent of AGENTS) {
    const rel = await configRel(t, agent, 'user');
    const home = tempDir(t, 'zn-utf8-home-');
    const project = tempDir(t, 'zn-utf8-proj-');
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"note": "caf\u00e9", "keep": true}\n');
    const i = await zn(home, project, ['install', agent, '--no-mcp']);
    assert.equal(i.rc, 0, i.err);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).note, 'caf\u00e9');
    const u = await zn(home, project, ['uninstall', agent, '--no-mcp']);
    assert.equal(u.rc, 0, u.err);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).note, 'caf\u00e9');
  }
});

test('init --wrap-mcp refuses a config with invalid UTF-8 and leaves it unchanged', async (t) => {
  const { configureEnvironments } = require('../lib/init');
  const dir = tempDir(t, 'zn-utf8-wrap-');
  const oldHome = process.env.HOME;
  process.env.HOME = dir; // resolveConfig() checks the config sits under the home directory
  t.after(() => { process.env.HOME = oldHome; });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"mcpServers": {"s": {"command": "npx", "args": ["x", "caf'), Buffer.from([0xe9]), Buffer.from('"]}}}\n')]));
  const before = sha(file);
  const env = { name: 'Test', id: 'test', filePath: file, key: 'mcpServers', format: 'mcpServers-json' };
  const r = configureEnvironments({ envList: [env] });
  assert.equal(r.actions.length, 1, JSON.stringify(r.actions));
  assert.equal(r.actions[0].status, 'error', JSON.stringify(r.actions));
  assert.match(r.actions[0].error, /not valid UTF-8 \(left unchanged\)/);
  assert.equal(sha(file), before);
});
