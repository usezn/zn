'use strict';

// `zn why` after a destructive `rm` block. The block record is the one the hook runner writes for a
// policy denial: rule id "hook-pre_tool-policy", no command text, no secret kinds. The log holds no
// specific rule id for destructive blocks, so `zn why` explains the generic hook-policy id.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');
const { explainRule } = require('../lib/rule-explanations');
const policy = require('../lib/hooks/policy');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-why-rm-'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { home, file };
}

test('a destructive rm is denied by the policy, and zn why names the rule and the next step', () => {
  // Static check only: the command is analysed, never run.
  const denial = policy.bashDenial('rm -rf ~', { cwd: '/home/example', home: '/home/example', destructiveRules: ['rm_root_home'] });
  assert.match(String(denial), /deletes the home folder/);

  const { home, file } = setup();
  logEvidence({
    agent: 'claude-code', phase: 'hook-pre_tool', tool_name: 'Bash',
    payload: JSON.stringify({ event: 'pre_tool', tool: 'Bash', kinds: [] }),
    verdict: 'block', rule: 'hook-pre_tool-policy', reason: 'blocked by the zn hook policy', engine: 'zn-hook',
  }, file, { noStats: true, _plainPreview: true });

  const info = explainRule('hook-pre_tool-policy');
  assert.ok(info && info.name && info.allow.note);

  const r = spawnSync(process.execPath, [CLI, 'why'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_HOME: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('hook-pre_tool-policy - ' + info.name), 'names the rule by its plain name');
  assert.match(r.stdout, /Why it matters:/);
  // Generic id: the table gives no command, so none is offered.
  assert.ok(r.stdout.includes(info.allow.note), 'prints the next step from the table');
  assert.doesNotMatch(r.stdout, /To go on, run this in your own terminal/);
  assert.match(r.stdout, /Missing from the log: which check of the hook fired/);
});
