'use strict';
// Static fake commands for the decision blocks of lib/hooks/policy.js and lib/hooks/runner.js that the suite did not reach:
// unterminated quotes, expansions and heredocs keep their network target visible (fail closed), and a post-tool check whose
// vault is locked still answers, while any other vault failure is not swallowed. Fake hosts only (ex.test); nothing runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-cov56-hooks-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const E = require('../lib/scrub/engine');

const hostsOf = (cmd) => policy.egressParts(cmd).flatMap((p) => p.hosts);

test('an unterminated quote inside a URL keeps its host visible to the network check', () => {
  const cases = [
    'curl "https://ex.test/$(echo "abc',
    'curl "https://ex.test/${X:-"abc',
    'curl \'https://ex.test/$(echo \'a\'',
    'curl https://ex.test/$(echo "x",',
  ];
  for (const c of cases) assert.deepEqual(hostsOf(c), ['ex.test'], c);
});

test('a command substitution inside a double-quoted argument, unterminated, is not read as a URL', () => {
  // No URL is named: nothing to report, and the check does not throw.
  assert.deepEqual(policy.egressParts('echo "$(echo `date`'), []);
});

test('heredocs: an expansion in an unquoted body is a request, a quoted delimiter is not expanded', () => {
  assert.deepEqual(hostsOf('cat <<EOF\n$(curl https://ex.test/a)\nEOF\n'), ['ex.test']);
  assert.deepEqual(hostsOf('cat <<EOF\n$(curl https://ex.test/b)'), ['ex.test'], 'no terminator');
  assert.deepEqual(hostsOf('cat <<-EOF\n\t$(curl https://ex.test/c)\n\tEOF\n'), ['ex.test'], 'tab-stripped');
  assert.deepEqual(hostsOf('cat << "EOF"\n`curl https://ex.test/e`\nEOF\n'), ['ex.test']);
  assert.deepEqual(hostsOf("cat <<'EOF'\nbody\nEOF\n"), []);
  assert.deepEqual(hostsOf('cat <<"EOF" > out.txt\n$(curl https://ex.test/)\nEOF'), []);
});

test('a patch sent as a shell command is refused as a whole, whatever file it names', () => {
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const cmd = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: " + file + "\n+x\n*** End Patch\nEOF";
    const note = { hit: null };
    const deny = policy.bashDenial(cmd, { home: HOME, instructionNotice: note });
    assert.match(String(deny), /blocked because it was sent as a shell command/, file);
  }
});

test('a post-tool check whose vault is locked is handed the locked error, to be failed closed by the caller', async () => {
  const ev = { event: 'post_tool', tool: 'mcp', toolName: 'mcp__srv__tool', input: {}, output: 'plain text', cwd: process.cwd(), sessionId: 's-locked' };
  const deps = {
    engine: () => E,
    vault: async () => { throw Object.assign(new Error('vault is locked'), { code: 'ZN_LOCKED' }); },
  };
  await assert.rejects(runner.decidePost(ev, deps, 'claude-code'), (err) => err.code === 'ZN_LOCKED');
});

test('a post-tool check whose vault fails for another reason is not swallowed', async () => {
  const ev = { event: 'post_tool', tool: 'mcp', toolName: 'mcp__srv__tool', input: {}, output: 'plain text', cwd: process.cwd(), sessionId: 's-broken' };
  const deps = {
    engine: () => E,
    vault: async () => { throw Object.assign(new Error('socket broke'), { code: 'ZN_UNAVAILABLE' }); },
  };
  await assert.rejects(runner.decidePost(ev, deps, 'claude-code'), /socket broke/);
});
