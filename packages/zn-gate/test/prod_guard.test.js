'use strict';

// The production data guard (lib/prod-guard.js): the shared corpus, the look-alikes that stay allowed, the repository
// reading for a push that names no branch, and the agent hooks (an ask where the agent can ask, a block where it cannot).

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const claude = require('../lib/agents/claude-code');
const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { checkProductionData, PROD_GUARD_RULES_VERSION, RULES } = require('../lib/prod-guard');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');
const corpus = require('./fixtures/destructive_commands.json');

const rule = (c, opts) => { const r = checkProductionData(c, opts); return r ? r.rule : null; };

test('the corpus is large enough and covers every rule', () => {
  assert.ok(corpus.prod_benign.length >= 100, 'benign look-alikes: ' + corpus.prod_benign.length);
  assert.ok(corpus.prod_risky.length >= 300, 'risky commands: ' + corpus.prod_risky.length);
  assert.deepEqual([...new Set(corpus.prod_risky.map((r) => 'prod:' + r.rule))].sort(), [...RULES].sort());
  assert.match(PROD_GUARD_RULES_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

test('every risky command is found under its own rule', () => {
  const wrong = corpus.prod_risky.filter((r) => rule(r.cmd) !== r.rule).map((r) => r.rule + ' <- ' + r.cmd + ' -> ' + rule(r.cmd));
  assert.deepEqual(wrong, []);
});

test('no benign look-alike is found', () => {
  assert.deepEqual(corpus.prod_benign.filter((c) => rule(c) !== null), []);
});

test('shapes the guard does not read are allowed, as the docs say', () => {
  assert.deepEqual(corpus.prod_not_covered.filter((x) => rule(x.cmd) !== null).map((x) => x.cmd), []);
});

test('the look-alikes named in the spec stay allowed', () => {
  const allowed = [
    "psql -c \"SELECT * FROM users WHERE name = 'DROP TABLE'\"",
    'terraform plan -destroy',
    'kubectl delete pod web-1',
    'aws s3 rm s3://example-bucket/file.txt',
    'gcloud sql instances describe prod-db-example',
    'gcloud projects describe example-project',
    'git push --force origin feature/login',
    'psql prod-db-example <<EOF\nSELECT * FROM users;\nEOF',
  ];
  for (const c of allowed) assert.equal(rule(c), null, c);
});

test('the answer has the reason, the next step and the command named', () => {
  const r = checkProductionData('terraform destroy -auto-approve');
  assert.equal(r.id, 'prod:terraform_destroy');
  assert.match(r.message, /^zn: this command is terraform destroy/);
  assert.match(r.message, /Approve only if the user asked for exactly this/);
  assert.match(r.deny, /^zn blocked this: it is terraform destroy/);
  assert.match(r.deny, /Next step: ask the user to confirm/);
  assert.equal(checkProductionData(undefined), null);
  assert.equal(checkProductionData(''), null);
  assert.equal(checkProductionData(42), null);
});

test('text that only mentions a command is data', () => {
  for (const c of ['echo "terraform destroy"', "echo 'kubectl delete namespace prod-example'", 'git commit -m "aws s3 rm --recursive"', 'grep -rn "gcloud projects delete" docs/']) {
    assert.equal(rule(c), null, c);
  }
});

test('a program named like an object property is just a program', () => {
  for (const c of ['constructor -c "x"', 'toString -e x', '__proto__ a b', 'hasOwnProperty --eval x']) assert.equal(rule(c), null, c);
});

test('SQL: strings and comments are data; statements after a semicolon or a line break are read', () => {
  assert.equal(rule('psql -c "SELECT 1; DROP TABLE users"'), 'sql_drop');
  assert.equal(rule('psql -c "SELECT 1\nDROP TABLE users"'), 'sql_drop');
  assert.equal(rule("psql -c \"SELECT 'it''s'; DROP TABLE users\""), 'sql_drop');
  assert.equal(rule("psql -c \"SELECT 'a;DROP TABLE users'\""), null);
  assert.equal(rule('psql -c "SELECT 1 /* ; DROP TABLE users */"'), null);
  assert.equal(rule('psql -c "SELECT 1 -- ; DROP TABLE users"'), null);
  // an unterminated quote never hides what follows
  assert.equal(rule("psql -c \"SELECT 'oops; DROP TABLE users\""), 'sql_drop');
  // TRUNCATE the function is not TRUNCATE the statement
  assert.equal(rule('mysql -e "SELECT TRUNCATE (3.14159, 2)"'), null);
  assert.equal(rule('mysql -e "TRUNCATE orders"'), 'sql_drop');
});

test('here-documents: only the body that feeds a SQL client or a shell is read', () => {
  assert.equal(rule('psql db <<EOF\nDROP TABLE users;\nEOF'), 'sql_drop');
  assert.equal(rule('psql db <<EOF\nSELECT 1;\nEOF\npsql db -c "DROP TABLE users"'), 'sql_drop');
  assert.equal(rule('cat <<EOF > notes.txt\nDROP TABLE users;\nEOF'), null);
  assert.equal(rule('cat > notes.sql <<EOF\nDROP TABLE users;\nEOF\npsql db -f notes.sql'), null);
  assert.equal(rule('bash <<EOF\nterraform destroy\nEOF'), 'terraform_destroy');
  // a here-document that never ends is not swallowed
  assert.equal(rule('psql db <<EOF\nDROP TABLE users;'), null);
  assert.equal(rule('psql db <<EOF && psql db -c "DROP TABLE users"\nSELECT 1;\nEOF'), 'sql_drop');
});

test('git push: a branch name decides; protected are main, master, release/* and the default branch', (t) => {
  assert.equal(rule('git push --force origin main'), 'git_force_push_protected');
  assert.equal(rule('git push --force origin release/9'), 'git_force_push_protected');
  assert.equal(rule('git push --force origin releases'), null);
  assert.equal(rule('git push --force origin mainline'), null);
  assert.equal(rule('git push -f origin HEAD:feature'), null);
  assert.equal(rule('git push --force origin tag-main'), null);
  assert.equal(rule('git push --force origin refs/tags/main'), null);
  assert.equal(rule('git push origin +feature:main'), 'git_force_push_protected');
  const r = checkProductionData('git push --force origin main');
  assert.match(r.message, /the protected branch main/);
  assert.match(checkProductionData('git push --force --all').message, /all branches, protected ones included/);
});

test('git push --mirror overwrites and deletes every remote ref, so it is asked without --force', () => {
  for (const c of ['git push --mirror origin', 'git push origin --mirror', 'git push --mirror', 'git push --mirror=origin', 'git push -v --mirror origin',
    'git push --no-verify --mirror origin', 'git push --mirror --force origin', 'git -C /srv/app push --mirror origin', 'cd /srv/app && git push origin --mirror']) {
    assert.equal(rule(c), 'git_force_push_protected', c);
  }
  assert.match(checkProductionData('git push --mirror origin').message, /all branches, protected ones included/);
  // not a mirror push: still allowed
  assert.equal(rule('git push origin mirror'), null);
  assert.equal(rule('git push --all origin'), null);
  assert.equal(rule('git push --dry-run origin main'), null);
});

test('deleting a protected branch on a remote is asked, in every form', () => {
  for (const c of ['git push origin --delete main', 'git push --delete origin master', 'git push origin -d main', 'git push -d origin release/1.2', 'git push origin :main',
    'git push origin :refs/heads/main', 'git push origin --delete feature-x main', 'git push origin :feature-x :master', 'git push origin --delete refs/heads/main',
    'git -C /srv/app push origin --delete main', 'cd /srv/app && git push origin :release/2.0', 'sudo git push origin -d main']) {
    assert.equal(rule(c), 'git_delete_protected_branch', c);
  }
  assert.match(checkProductionData('git push origin --delete main').message, /deleting the protected branch main/);
  // a non-protected branch can be deleted
  for (const c of ['git push origin --delete feature-x', 'git push origin -d feature-x', 'git push origin :feature-x', 'git push origin --delete feature-x fix/typo', 'git push origin main',
    'git push origin HEAD:main', 'git push origin --delete refs/tags/main', 'git push origin :release']) {
    assert.equal(rule(c), null, c);
  }
  // +:main and HEAD:main are not read as a delete: a force is still a force push
  assert.equal(rule('git push origin +:main'), 'git_force_push_protected');
  assert.equal(rule('git push --force origin HEAD:main'), 'git_force_push_protected');
});

function makeRepo(t, { head, originHead }) {
  const root = tempDir(t, 'zn-prodguard-');
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/' + head + '\n');
  if (originHead) fs.writeFileSync(path.join(git, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/' + originHead + '\n');
  const sub = path.join(root, 'src');
  fs.mkdirSync(sub);
  return { root, sub };
}

test('git push with no branch name: the current branch and the default branch are read from the repository files', (t) => {
  const onMain = makeRepo(t, { head: 'main' });
  const onFeature = makeRepo(t, { head: 'feature/login', originHead: 'main' });
  const onTrunk = makeRepo(t, { head: 'trunk', originHead: 'trunk' });
  assert.equal(rule('git push --force', { cwd: onMain.sub }), 'git_force_push_protected');
  assert.equal(rule('git push --force-with-lease origin', { cwd: onMain.root }), 'git_force_push_protected');
  assert.equal(rule('git push -f origin HEAD', { cwd: onMain.root }), 'git_force_push_protected');
  assert.equal(rule('git push --force', { cwd: onFeature.sub }), null);
  assert.equal(rule('git push --force origin HEAD', { cwd: onFeature.root }), null);
  // the repository's default branch is protected too, whatever its name
  assert.equal(rule('git push --force', { cwd: onTrunk.root }), 'git_force_push_protected');
  assert.equal(rule('git push --force origin trunk', { cwd: onFeature.root }), null);
  const other = makeRepo(t, { head: 'feature/x', originHead: 'trunk' });
  assert.equal(rule('git push --force origin trunk', { cwd: other.root }), 'git_force_push_protected');
  // git -C names the repository; without a repository nothing can be read
  assert.equal(rule('git -C ' + onMain.root + ' push --force', { cwd: onFeature.root }), 'git_force_push_protected');
  assert.equal(rule('git push --force', { cwd: tempDir(t, 'zn-norepo-') }), null);
  assert.equal(rule('git push --force'), null);
  // not forced: never asked
  assert.equal(rule('git push', { cwd: onMain.root }), null);
});

// ---------------------------------- agent hooks ----------------------------------

function homeWith(t, config) {
  const home = tempDir(t, 'zn-home-');
  if (config) {
    fs.mkdirSync(path.join(home, '.zn'));
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(config));
  }
  return home;
}
function claudeRaw(command, cwd) {
  return { session_id: 'abc123', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_01' };
}
function runWith(adapter, raw, home) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}
function hookOut(res) { return res.output && res.output.hookSpecificOutput; }

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const CLEAN_ENV = { ZN_STRICT: undefined, ZN_PROD_GUARD: undefined, ZN_BLOCK_DESTRUCTIVE: undefined };

const CASES = [
  ['psql -c "DROP DATABASE prod-db-example"', /DROP DATABASE, DROP TABLE or TRUNCATE/],
  ['terraform destroy', /terraform destroy/],
  ['kubectl delete namespace prod-example', /kubectl delete namespace/],
  ['kubectl delete pods --all -n prod-example', /kubectl delete --all/],
  ['aws s3 rm s3://example-bucket --recursive', /aws s3 rm --recursive/],
  ['aws rds delete-db-instance --db-instance-identifier prod-db-example', /aws rds delete-\*/],
  ['gcloud sql instances delete prod-db-example', /gcloud delete/],
  ['git push --force origin main', /force push to the protected branch main/],
];

test('Claude Code: the command asks the user, with the reason and what to check first', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const dir = tempDir(t, 'zn-proj-');
    const home = homeWith(t, null);
    for (const [command, what] of CASES) {
      const res = await runWith(claude, claudeRaw(command, dir), home);
      assert.equal(res.decision.decision, 'ask', command);
      const h = hookOut(res);
      assert.equal(h.permissionDecision, 'ask', command);
      assert.match(h.permissionDecisionReason, what, command);
      assert.match(h.permissionDecisionReason, /Approve only if the user asked for exactly this/);
    }
  });
});

test('Claude Code: the look-alikes run without a question', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const dir = tempDir(t, 'zn-proj-');
    const home = homeWith(t, null);
    for (const command of ['terraform plan -destroy', 'kubectl delete pod web-1', 'aws s3 rm s3://example-bucket/file.txt', 'gcloud sql instances describe prod-db-example', 'git push --force origin feature/login',
      "psql -c \"SELECT * FROM t WHERE name = 'DROP TABLE'\"", 'psql prod-db-example <<EOF\nSELECT 1;\nEOF']) {
      const res = await runWith(claude, claudeRaw(command, dir), home);
      assert.equal(res.decision.decision, 'allow', command);
      assert.equal(res.output, null, command);
    }
  });
});

test('Claude Code: a SQL here-document in the command line asks', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const dir = tempDir(t, 'zn-proj-');
    const res = await runWith(claude, claudeRaw('psql prod-db-example <<EOF\nDROP TABLE users;\nEOF', dir), homeWith(t, null));
    assert.equal(hookOut(res).permissionDecision, 'ask');
  });
});

test('Claude Code: a push with no branch name asks when the repository is on a protected branch', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const repo = makeRepo(t, { head: 'main' });
    const res = await runWith(claude, claudeRaw('git push --force', repo.sub), homeWith(t, null));
    assert.equal(hookOut(res).permissionDecision, 'ask');
    const feat = makeRepo(t, { head: 'feature/x', originHead: 'main' });
    assert.equal((await runWith(claude, claudeRaw('git push --force', feat.sub), homeWith(t, null))).output, null);
  });
});

test('Codex CLI cannot ask: the command is blocked, the reason names it and gives the next step', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const dir = tempDir(t, 'zn-proj-');
    const home = homeWith(t, null);
    const codex = getAdapter('codex');
    for (const [command, what] of CASES) {
      const res = await runWith(codex, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir }, home);
      assert.equal(res.decision.decision, 'ask', command);
      const h = hookOut(res);
      assert.equal(h.permissionDecision, 'deny', command);
      assert.match(h.permissionDecisionReason, what, command);
      assert.match(h.permissionDecisionReason, /cannot show that question, so zn blocked the action instead/);
      assert.match(h.permissionDecisionReason, /Next step: tell the user exactly what was blocked/);
    }
    const perm = await runWith(codex, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'terraform destroy' }, cwd: dir }, home);
    assert.equal(hookOut(perm).decision.behavior, 'deny');
    // a look-alike is not touched
    assert.equal((await runWith(codex, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'terraform plan -destroy' }, cwd: dir }, home)).output, null);
  });
});

test('the other agents that cannot ask block it too, and a question never turns into a pass', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const dir = tempDir(t, 'zn-proj-');
    const home = homeWith(t, null);
    const gemini = await runWith(getAdapter('gemini'), { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'kubectl delete namespace prod-example' }, cwd: dir }, home);
    assert.equal(gemini.output.decision, 'deny');
    assert.match(gemini.output.reason, /kubectl delete namespace/);
    const opencode = await runWith(getAdapter('opencode'), { hook: 'tool.execute.before', tool: 'bash', args: { command: 'terraform destroy' }, cwd: dir }, home);
    assert.equal(opencode.output.action, 'deny');
    // Cursor's shell hook can ask; its preToolUse hook cannot and blocks
    const cursorShell = await runWith(getAdapter('cursor'), { hook_event_name: 'beforeShellExecution', command: 'terraform destroy', cwd: dir }, home);
    assert.equal(cursorShell.output.permission, 'ask');
    const cursor = await runWith(getAdapter('cursor'), { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'terraform destroy' }, cwd: dir }, home);
    assert.ok(cursor.output === null || cursor.output.permission === 'deny');
  });
});

test('settings: off turns the guard off, deny blocks everywhere, strict and the environment can only raise it', async (t) => {
  const dir = tempDir(t, 'zn-proj-');
  const cmd = 'terraform destroy';
  await withEnv(CLEAN_ENV, async () => {
    const off = homeWith(t, { hooks: { productionDataGuard: 'off' } });
    assert.equal((await runWith(claude, claudeRaw(cmd, dir), off)).output, null);
    assert.equal((await runWith(claude, claudeRaw(cmd, dir), homeWith(t, { hooks: { productionDataGuard: false } }))).output, null);
    const deny = homeWith(t, { hooks: { productionDataGuard: 'deny' } });
    const d = await runWith(claude, claudeRaw(cmd, dir), deny);
    assert.equal(d.decision.decision, 'deny');
    assert.match(hookOut(d).permissionDecisionReason, /^zn blocked this: it is terraform destroy.*Next step: ask the user to confirm/);
    assert.equal((await runWith(claude, claudeRaw(cmd, dir), homeWith(t, { hooks: { strict: true } }))).decision.decision, 'deny');
    // the environment raises the level but cannot lower it
    await withEnv({ ZN_PROD_GUARD: 'deny' }, async () => {
      assert.equal((await runWith(claude, claudeRaw(cmd, dir), homeWith(t, null))).decision.decision, 'deny');
    });
    await withEnv({ ZN_STRICT: '1' }, async () => {
      assert.equal((await runWith(claude, claudeRaw(cmd, dir), homeWith(t, null))).decision.decision, 'deny');
    });
    await withEnv({ ZN_PROD_GUARD: 'off' }, async () => {
      assert.equal((await runWith(claude, claudeRaw(cmd, dir), homeWith(t, null))).decision.decision, 'ask');
    });
  });
});

test('PowerShell and monitors use the guard too', async (t) => {
  await withEnv(CLEAN_ENV, async () => {
    const dir = tempDir(t, 'zn-proj-');
    const home = homeWith(t, null);
    const ps = await runWith(claude, { ...claudeRaw('terraform destroy', dir), tool_name: 'PowerShell' }, home);
    assert.equal(hookOut(ps).permissionDecision, 'ask');
    const mon = await runWith(claude, { ...claudeRaw('terraform destroy', dir), tool_name: 'Monitor' }, home);
    assert.ok(mon.decision.decision === 'ask' || mon.decision.decision === 'deny', JSON.stringify(mon.decision));
    assert.notEqual(mon.decision.decision, 'allow');
  });
});

test('hostile long input stays linear', () => {
  const inputs = ['a'.repeat(100000), "'".repeat(100001), '"'.repeat(100001), "psql -c \"" + "'a".repeat(40000), 'psql -c "' + ' '.repeat(100000) + 'DROP TABLE x"',
    'psql <<EOF\n' + 'a\n'.repeat(50000), 'psql <<EOF\n'.repeat(20000), '<<EOF '.repeat(20000), 'psql -c "' + ';'.repeat(100000) + '"', 'psql -c "' + '\n'.repeat(100000) + '"',
    'git push ' + '--force '.repeat(20000), 'git push ' + 'a '.repeat(50000) + '--force', 'aws ' + '--profile x '.repeat(10000) + 's3 rm', 'kubectl ' + '-n x '.repeat(20000) + 'delete',
    'gcloud ' + 'sql instances '.repeat(20000), 'terraform ' + '-x '.repeat(40000), '/*'.repeat(50000), '--'.repeat(50000), 'psql -c "' + '/*'.repeat(50000), 'sh -c '.repeat(15000), '; '.repeat(40000),
    'mongosh --eval "' + '.drop('.repeat(30000), 'psql ' + '-c '.repeat(30000)];
  for (const input of inputs) {
    const t0 = Date.now();
    checkProductionData(input);
    assert.ok(Date.now() - t0 < 3000, 'slow input: ' + input.slice(0, 20) + ' (' + input.length + ' chars)');
  }
  // doubling the size does not much more than double the time on the shapes that read quotes and lines
  const time = (n) => { const s = 'psql -c "' + "'a;".repeat(n); const t0 = process.hrtime.bigint(); checkProductionData(s); return Number(process.hrtime.bigint() - t0) / 1e6; };
  time(2000);
  const a = Math.max(time(20000), 1);
  const b = time(60000);
  assert.ok(b < a * 12 + 200, 'not linear: ' + a + ' ms -> ' + b + ' ms');
});
