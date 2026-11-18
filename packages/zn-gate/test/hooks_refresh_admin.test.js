'use strict';

// The hook launchers run the hook only while the installed zn-gate files match the digest they recorded. The launcher
// refresh (lib/agents/refresh.js, the postinstall step) and a reinstall or rebuild of zn-gate record the files as they are
// now, so an agent that changed a file of the package could make the launchers trust it. Like `zn hooks install`, these
// commands are the user's: the agent gets a deny with the next step. Only the policy is checked here: nothing is run, and
// every path is an obviously made-up prefix.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const PREFIX = '/opt/example-prefix/lib/node_modules/zn-gate';
const WIN_PREFIX = 'C:\\example\\prefix\\node_modules\\zn-gate';

test('an agent may not run the hook launcher refresh, in any spelling', () => {
  for (const c of [
    'node ' + PREFIX + '/lib/agents/refresh.js',
    'node "' + PREFIX + '/lib/agents/refresh.js"',
    'node lib/agents/refresh.js',
    'cd ' + PREFIX + ' && node lib/agents/refresh',
    '/usr/bin/node --no-warnings ' + PREFIX + '/lib/agents/refresh.js',
    'nodejs ' + PREFIX + '/lib/agents/refresh.cjs',
    'bun ' + PREFIX + '/lib/agents/refresh.js',
    'node -r ' + PREFIX + '/lib/agents/refresh.js -e 0',
    'node --require=' + PREFIX + '/lib/agents/refresh.js -e 0',
    'node -e "require(\'' + PREFIX + '/lib/agents/refresh.js\').main()"',
    'node -e "const x = 1; require(\'' + PREFIX + '/lib/agents/refresh\').main()"',
    'node -e "require(\'' + PREFIX + '/lib/agents/launcher\').writeLauncher(\'claude-code\', process.execPath, \'r\')"',
    'node --input-type=module -e "import(\'' + PREFIX + '/lib/agents/refresh.js\')"',
    'node.exe ' + WIN_PREFIX + '\\lib\\agents\\refresh.js',
    'node ' + PREFIX + '/lib/agents/re""fresh.js',
    'echo ok; node ' + PREFIX + '/lib/agents/refresh.js',
    // Path spellings that name the same file.
    'node ' + PREFIX + '/lib/./agents/refresh.js',
    'node ' + PREFIX + '/lib/agents/../agents/refresh.js',
    'node ' + PREFIX + '/lib//agents///refresh.js',
    'node ' + PREFIX + '/bin/../lib/agents/./refresh.js',
    'node ' + PREFIX + '/LIB/Agents/Refresh.JS',
    'node.exe ' + WIN_PREFIX + '\\lib\\.\\agents\\..\\agents\\REFRESH.js',
    // A cd, pushd or Set-Location earlier in the same command.
    'cd ' + PREFIX + '/lib/agents && node refresh.js',
    'cd ' + PREFIX + '/lib/agents; node ./refresh.js',
    'cd ' + PREFIX + '/lib && node agents/refresh',
    'cd ' + PREFIX + ' && cd lib/agents && node refresh.js',
    'cd ' + PREFIX + '/lib/agents/../agents && node refresh.js',
    'pushd ' + PREFIX + '/lib/agents && node refresh.js && popd',
    '(cd ' + PREFIX + '/lib/agents && node launcher.js)',
    'cd ' + PREFIX + '/lib/agents && node -e "require(\'./refresh\').main()"',
    'Set-Location ' + WIN_PREFIX + '\\lib\\agents; node refresh.js',
    'cd /d ' + WIN_PREFIX + '\\lib\\agents && node refresh.js',
  ]) {
    const d = policy.bashDenial(c) || '';
    assert.match(d, /zn blocked this: the hook launcher refresh/, c);
    assert.match(d, /their own terminal/, c);
  }
});

test('an agent may not install, update, rebuild or link zn-gate with a package manager', () => {
  for (const c of [
    'npm install -g zn-gate', 'npm i -g zn-gate@1.16.0', 'npm install --global zn-gate@latest', 'npm i zn-gate', 'npm update -g zn-gate', 'npm up -g zn-gate',
    'npm rebuild -g zn-gate', 'npm rb zn-gate', 'npm link zn-gate', 'npm explore -g zn-gate -- npm run postinstall', 'sudo npm i -g zn-gate', 'FOO=1 npm i -g zn-gate',
    'npm i -g ./zn-gate-1.16.0.tgz', 'npm i -g ' + PREFIX, 'npm i -g foo@npm:zn-gate@1.0.0', 'npm --prefix ' + PREFIX + ' run postinstall',
    'npm --prefix=' + PREFIX + ' run-script postinstall', 'cd ' + PREFIX + ' && npm rebuild', 'cd ' + PREFIX + ' && npm run postinstall',
    'pnpm add -g zn-gate', 'pnpm update -g zn-gate', 'yarn global add zn-gate@1.0.0', 'bun add -g zn-gate', 'volta install zn-gate',
    'npm.cmd install -g zn-gate', '"npm" i -g "zn-gate"', 'npm i -g zn-ga""te', 'npx npm install -g zn-gate', 'echo ok && npm install -g zn-gate',
  ]) {
    const d = policy.bashDenial(c) || '';
    assert.match(d, /zn blocked this: installing, updating, rebuilding or linking the zn-gate package/, c);
    assert.doesNotMatch(d, /removing/, c);
    assert.match(d, /their own terminal/, c);
  }
});

test('reading the files and other package commands stay allowed', () => {
  for (const c of [
    'npm test', 'npm install', 'npm ci', 'npm install lodash', 'npm i -D typescript', 'npm run build', 'npm run postinstall', 'npm ls zn-gate', 'npm view zn-gate version',
    'npm outdated -g zn-gate', 'npm audit', 'pnpm install', 'yarn add react', 'npx -y zn-gate audit', 'zn-gate --version',
    'cat ' + PREFIX + '/lib/agents/refresh.js', 'grep -n main lib/agents/refresh.js', 'less lib/agents/launcher.js', 'sed -n 1,20p lib/agents/refresh.js',
    'cat ' + PREFIX + '/lib/./agents/../agents/refresh.js', 'cd ' + PREFIX + '/lib/agents && cat refresh.js', 'cd ' + PREFIX + '/lib/agents && grep main refresh.js',
    'node --test test/hooks_launcher_refresh.test.js', 'node lib/agents/other.js', 'node scripts/refresh.js', 'git diff lib/agents/refresh.js',
    'node lib/agents/refresher.js', 'node src/agents/refresh.js', 'cd /opt/example-prefix/other-tool/scripts && node refresh.js', 'node refresh.js',
    'cd ' + PREFIX + '/lib/agents && cd /opt/example-prefix/other-tool && node refresh.js', 'node ' + PREFIX + '/lib/agents/../refresh.js',
    'cd packages/zn-gate && npm install', 'npm install some-zn-gate-plugin', 'npm i zn-gate-helper', 'npm uninstall -g zn-gate', 'npm rm -g zn-gate',
    'git commit -m "docs: run npm update -g zn-gate"', 'echo node lib/agents/refresh.js', 'git log --grep="npm i -g zn-gate"',
  ]) {
    assert.equal(policy.bashDenial(c), null, c);
  }
});

test('inline code may not build the refresh path from string constants', () => {
  for (const c of [
    // The exact command from the review.
    'node -e "require(\'/opt/example-prefix/lib/agents/\' + \'refresh.js\').main()"',
    'node -e \'require("/opt/example-prefix/lib/agents/" + "refresh.js").main()\'',
    'node -e \'require(`/opt/example-prefix/lib/agents/` + `refresh.js`).main()\'',
    'node -e "require(\'/opt/example-prefix/lib/agents/\'+\'refresh.js\').main()"',
    'node -e "require(\'/opt/example-prefix/lib/agents/\'   +   \'refresh.js\').main()"',
    'node -e "require(\'/opt/example-prefix/lib/\' + \'agents/\' + \'refresh.js\').main()"',
    'node -e "require(\'/opt/example-prefix/lib/agents/ref\' + \'resh.js\').main()"',
    'node -e "require(\'/opt/example-prefix/lib/agents/\' + \"launcher\" + `.js`)"',
    'node -p "require(\'/opt/example-prefix/lib/agents/\' + \'refresh.js\')"',
    'node --eval="require(\'/opt/example-prefix/lib/agents/\' + \'refresh.js\').main()"',
    'node -e "require(\'/opt/example-prefix/lib/agents/\\x72efresh.js\').main()"',
    'cd ' + PREFIX + '/lib && node -e "require(\'./agents/\' + \'refresh\').main()"',
    'deno eval "import(\'/opt/example-prefix/lib/agents/\' + \'refresh.js\')"',
    // A name built at run time cannot be read from the text: refused when the code names the refresh or launcher.
    'node -e "const d = \'/opt/example-prefix/lib/agents/\'; require(d + \'refresh.js\').main()"',
    'node -e \'const f = "refresh.js"; require(`/opt/example-prefix/lib/agents/${f}`).main()\'',
    'node -e "require([\'/opt/example-prefix/lib/agents\', \'refresh.js\'].join(\'/\')).main()"',
  ]) {
    const d = policy.bashDenial(c) || '';
    assert.match(d, /zn blocked this: the hook launcher refresh/, c);
    assert.match(d, /their own terminal/, c);
  }
});

test('ordinary inline code stays allowed', () => {
  for (const c of [
    'node -e "console.log(1 + 2)"',
    'node -e "console.log(\'a\' + \'b\')"',
    'node -p "require(\'./package.json\').version"',
    'node -e "const p = require(\'path\'); console.log(p.join(\'a\', \'b\'))"',
    'node -e "console.log(\'refresh done: \' + Date.now())"',
    'node -e "require(\'./scripts/refresh-cache.js\')"',
    'node -e "require(\'/opt/example-prefix/lib/\' + \'other.js\')"',
  ]) {
    assert.equal(policy.bashDenial(c), null, c);
  }
});

test('the same commands are refused from PowerShell', () => {
  for (const c of ['npm install -g zn-gate', '& node "' + PREFIX + '/lib/agents/refresh.js"', 'Set-Location ' + WIN_PREFIX + '\\lib\\agents; node .\\refresh.js']) {
    assert.match(policy.bashDenial(c, { powershell: true }) || '', /zn blocked this/, c);
  }
});

test('a long command is checked in linear time', () => {
  // Only the admin-command check is timed (the rest of the shell check has its own timing tests).
  const t0 = process.hrtime.bigint();
  assert.equal(policy.adminCommand(('node a "x" ').repeat(8000) + 'agents/refresh'), null);
  assert.equal(policy.adminCommand('npm ' + 'install '.repeat(10000)), null);
  assert.equal(policy.adminCommand(('npm exec ' + '-- '.repeat(20)).repeat(1500)), null);
  assert.equal(policy.adminCommand(('sudo npm x ' + 'b'.repeat(50) + ' ').repeat(1500) + ' zn-gate'), null);
  assert.equal(policy.adminCommand(('cd ' + '../'.repeat(50) + 'x; ').repeat(500) + 'node refresh.js'), null);
  assert.equal(policy.adminCommand('node ' + 'refresh/'.repeat(5000) + 'x.js'), null);
  assert.equal(policy.adminCommand('node -e "x(' + "'a' + ".repeat(20000) + "'b')\""), null);
  assert.equal(policy.adminCommand('node -e ' + "'a\\x41".repeat(20000)), null);
  assert.equal(policy.adminCommand('npm' + ' -a b'.repeat(15000) + ' install -g zn-gate'), 'zn-gate package', 'padding does not hide it');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, 'took ' + ms + ' ms');
});
