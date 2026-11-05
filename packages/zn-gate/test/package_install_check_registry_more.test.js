'use strict';

process.env.ZN_STATS = 'off';

// Package install check, round 4: more ways a registry is set in the same command line (config files written in the
// line, the `set` alias, flags before config, PowerShell and Windows forms). Every one makes all installs in the line
// private. No network: the fetcher throws if it is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');

const P = 'https://pypi.corp.example.invalid/simple';
const N = 'https://npm.corp.example.invalid';
const regOf = (cmd) => pc.installsOf(cmd).map((i) => i.registry);

const SETTERS = [
  // 1. a config file written in the line
  ['npm', `echo "registry=${N}" > .npmrc`],
  ['npm', `echo registry=${N}>.npmrc`],
  ['npm', `printf 'registry=${N}\\n' > .npmrc`],
  ['npm', `echo "@corp:registry=${N}" >> ~/.npmrc`],
  ['npm', `echo registry=${N} | tee .npmrc`],
  ['npm', `echo registry=${N} | tee -a "$HOME/.npmrc"`],
  ['pip', 'cat > pip.conf'],
  ['pip', `printf '[global]\\nindex-url=${P}' > ~/.config/pip/pip.conf`],
  ['pip', 'echo x > pip.ini'],
  ['yarn', `echo 'npmRegistryServer: "${N}"' > .yarnrc.yml`],
  ['yarn', 'echo x > .yarnrc'],
  ['bun', 'echo x > bunfig.toml'],
  ['uv', 'echo x > uv.toml'],
  ['npm', 'cp corp.npmrc .npmrc'],
  // 2. the set subcommand and other config keys
  ['npm', `npm set registry ${N}`],
  ['pnpm', `pnpm set registry ${N}`],
  ['npm', `npm set @corp:registry=${N}`],
  ['yarn', `yarn config set npmRegistryServer ${N}`],
  ['yarn', `yarn config set --home npmRegistryServer "${N}"`],
  // 3. flags before the config subcommand
  ['npm', `npm --registry ${N} config set always-auth true`],
  ['npm', `npm --registry=${N} config list`],
  ['npm', 'npm --loglevel silent --userconfig ./corp.npmrc config list'],
  ['pip', `pip --index-url ${P} config list`],
  ['uv', `uv --index-url=${P} pip list`],
  // 4. PowerShell and Windows forms
  ['pip', `Set-Item env:PIP_INDEX_URL "${P}"`],
  ['pip', `Set-Item -Path env:PIP_INDEX_URL -Value "${P}"`],
  ['pip', `New-Item -Path env:PIP_INDEX_URL -Value "${P}"`],
  ['pip', `set-item ENV:pip_index_url ${P}`],
  ['pip', `[Environment]::SetEnvironmentVariable("PIP_INDEX_URL", "${P}", "User")`],
  ['pip', `[Environment]::SetEnvironmentVariable('pip_extra_index_url','${P}')`],
  ['pip', `setx PIP_INDEX_URL ${P}`],
  ['pip', `setx PIP_INDEX_URL "${P}"`],
  ['npm', `setx NPM_CONFIG_REGISTRY ${N}`],
  ['pip', `$env:PIP_INDEX_URL = "${P}"`],
  ['pip', `$env:PIP_INDEX_URL   =   '${P}'`],
  ['npm', `$Env:Npm_Config_Registry="${N}"`],
];
const INSTALL = {
  npm: 'npm i corp-internal',
  pnpm: 'pnpm add corp-internal',
  yarn: 'yarn add corp-internal',
  bun: 'bun add corp-internal',
  pip: 'pip install corp-billing-sdk',
  uv: 'uv add corp-billing-sdk',
};

const JOINS = [
  (a, b) => `${a} && ${b}`,
  (a, b) => `${a}; ${b}`,
  (a, b) => `${a}\n${b}`,
  (a, b) => 'sh -c ' + JSON.stringify(a + ' && ' + b),
];

const PRIVATE = [];
for (const [eco, setter] of SETTERS) for (const j of JOINS) PRIVATE.push(j(setter, INSTALL[eco]));

for (const cmd of PRIVATE) {
  test('registry form marks every install: ' + JSON.stringify(cmd), () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1, 'a name was read');
    assert.ok(r.every((x) => x === true), 'registry is true for every name');
  });
}

test('online: none of the private forms makes a request', async () => {
  let calls = 0;
  const fetch = () => { calls++; throw new Error('the public registry must not be asked'); };
  for (const cmd of PRIVATE) {
    const asked = pc.installsOf(cmd).filter((i) => !i.registry);
    if (asked.length) await reg.lookupMany(asked, { fetch });
  }
  assert.equal(calls, 0);
});

const PUBLIC = [
  'echo hello > notes.txt && npm i lodash',
  'npm config get registry && npm i lodash',
  'npm set loglevel silent && npm i lodash',
  'setx FOO bar && pip install requests',
  'Set-Item env:FOO x; pip install requests',
  'printf x > readme.md && pip install requests',
  'cat .npmrc && npm i lodash',
  'grep registry .npmrc && npm i lodash',
  '$env:FOO = "x"; pip install requests',
  '[Environment]::SetEnvironmentVariable("FOO", "x"); pip install requests',
  'echo $env:PIP_INDEX_URL; pip install requests',
  'cat pip.conf | head && pip install requests',
];

for (const cmd of PUBLIC) {
  test('still looked up: ' + JSON.stringify(cmd), () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1);
    assert.ok(r.every((x) => x === false), 'registry stays false');
  });
}
