'use strict';

process.env.ZN_STATS = 'off';

// Package install check: a command that sets, names or reads another registry, index or settings file is never looked up
// in the public registry, whatever the form. Under the allow list (see package_install_check_plain_install.test.js) these
// commands are simply not plain, so their names are checked offline only. No network: the lookup is a spy.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');

const P = 'https://pypi.corp.example.invalid/simple';
const N = 'https://npm.corp.example.invalid';
const INSTALL = {
  npm: 'npm i corp-internal',
  pnpm: 'pnpm add corp-internal',
  yarn: 'yarn add corp-internal',
  bun: 'bun add corp-internal',
  pip: 'pip install corp-billing-sdk',
  uv: 'uv add corp-billing-sdk',
};

async function askedFor(command) {
  const asked = [];
  await pc.check(command, {
    mode: 'online',
    lookup: async (items) => { asked.push(...items.map((i) => i.name)); return new Map(); },
  });
  return asked;
}

// Config files written or set in the line, the set and config subcommands, flags before a config subcommand, and the
// PowerShell and Windows setters.
const SETTERS = [
  ['npm', `echo "registry=${N}" > .npmrc`],
  ['npm', `echo registry=${N}>.npmrc`],
  ['npm', `echo "registry=${N}" >| .npmrc`],
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
  ['npm', `npm set registry ${N}`],
  ['pnpm', `pnpm set registry ${N}`],
  ['npm', `npm set @corp:registry=${N}`],
  ['yarn', `yarn config set npmRegistryServer ${N}`],
  ['yarn', `yarn config set --home npmRegistryServer "${N}"`],
  ['npm', `npm config set registry ${N}`],
  ['yarn', `yarn config set registry ${N}`],
  ['pnpm', `pnpm config set registry ${N}`],
  ['npm', `npm --registry ${N} config set always-auth true`],
  ['npm', `npm --registry=${N} config list`],
  ['npm', 'npm --loglevel silent --userconfig ./corp.npmrc config list'],
  ['pip', `pip --index-url ${P} config list`],
  ['uv', `uv --index-url=${P} pip list`],
  ['pip', `Set-Item env:PIP_INDEX_URL "${P}"`],
  ['pip', `Set-Item -Path env:PIP_INDEX_URL -Value "${P}"`],
  ['pip', `New-Item -Path env:PIP_INDEX_URL -Value "${P}"`],
  ['pip', `set-item ENV:pip_index_url ${P}`],
  ['pip', `[Environment]::SetEnvironmentVariable("PIP_INDEX_URL", "${P}", "User")`],
  ['pip', `[Environment]::SetEnvironmentVariable('pip_extra_index_url','${P}')`],
  ['pip', `setx PIP_INDEX_URL ${P}`],
  ['npm', `setx NPM_CONFIG_REGISTRY ${N}`],
  ['pip', `$env:PIP_INDEX_URL = "${P}"`],
  ['npm', `$Env:Npm_Config_Registry="${N}"`],
];

// A variable set in front of the install, exported earlier in the line, or set in a group or a function.
const INLINE_AND_CHAINED = [
  `PIP_INDEX_URL=${P} pip install corp-billing-sdk`,
  `PIP_EXTRA_INDEX_URL=${P} pip3 install corp-billing-sdk`,
  `PIP_FIND_LINKS=https://files.example.invalid/ python -m pip install corp-billing-sdk`,
  `PIP_CONFIG_FILE=/work/pip.conf pip install corp-billing-sdk`,
  `UV_INDEX_URL=${P} uv add corp-billing-sdk`,
  `UV_DEFAULT_INDEX=${P} uv pip install corp-billing-sdk`,
  `UV_INDEX_CORP=${P} uv add corp-billing-sdk`,
  `UV_CONFIG_FILE=/work/uv.toml uv add corp-billing-sdk`,
  `npm_config_registry=${N} npm i corp-internal`,
  `NPM_CONFIG_REGISTRY=${N} pnpm add corp-internal`,
  `YARN_NPM_REGISTRY_SERVER=${N} yarn add corp-internal`,
  `NPM_CONFIG_USERCONFIG=/work/npmrc npm i corp-internal`,
  `env PIP_INDEX_URL=${P} pip install corp-billing-sdk`,
  `sudo env PIP_INDEX_URL=${P} pip install corp-billing-sdk`,
  `sudo -u build env npm_config_registry=${N} npm i corp-internal`,
  `cd app && PIP_INDEX_URL=${P} pip install corp-billing-sdk`,
  `PIP_INDEX_URL=${P} sh -c "pip install corp-billing-sdk"`,
  `npm i --@corp:registry=${N} @corp/internal`,
  `pnpm add --config.registry=${N} corp-internal`,
  `npm i --userconfig /work/npmrc corp-internal`,
  `uv add --config-file /work/uv.toml corp-billing-sdk`,
  `export PIP_INDEX_URL=${P} && pip install corp-billing-sdk`,
  `export PIP_INDEX_URL=${P}; pip install corp-billing-sdk`,
  `PIP_INDEX_URL=${P}; pip install corp-billing-sdk`,
  `PIP_INDEX_URL=${P}\npip install corp-billing-sdk`,
  `declare -x PIP_INDEX_URL=${P} && pip install corp-billing-sdk`,
  `export FOO=1 PIP_INDEX_URL=${P} && sudo pip install corp-billing-sdk`,
  `export PIP_INDEX_URL=${P} && sh -c "pip install corp-billing-sdk"`,
  `sh -c "export PIP_INDEX_URL=${P} && pip install corp-billing-sdk"`,
  `export NPM_CONFIG_REGISTRY=${N} && npm i corp-internal`,
  `{ export PIP_INDEX_URL=${P}; pip install corp-billing-sdk; }`,
  `{ readonly PIP_INDEX_URL=${P}; pip install corp-billing-sdk; }`,
  `f() { local PIP_INDEX_URL=${P}; pip install corp-billing-sdk; }; f`,
  `function f { setx PIP_INDEX_URL ${P}; pip install corp-billing-sdk; }; f`,
  `if true; then export PIP_INDEX_URL=${P}; pip install corp-billing-sdk; fi`,
  `PIP_INDEX_URL= pip install corp-billing-sdk`,
  `PIP_INDEX_URL=${P} echo hi && pip install corp-billing-sdk`,
  `export PIP_INDEX_URL= && pip install corp-billing-sdk`,
  `npm config get registry && npm i corp-internal`,
  `echo $env:PIP_INDEX_URL; pip install corp-billing-sdk`,
  `echo "registry=${N}" > /dev/null && npm i corp-internal`,
  `sh -c 'echo registry=${N} > .npmrc && npm i corp-internal'`,
];

// Settings files read in the line, and registry words anywhere in it.
const READS = [
  'cat .npmrc && npm i left-pad',
  'grep registry .npmrc && npm i left-pad',
  'if true; then cat .npmrc; fi; npm i left-pad',
  'cat pip.conf | head && pip install requests',
];

const ALL_PRIVATE = [];
for (const [eco, setter] of SETTERS) {
  for (const join of [(a, b) => `${a} && ${b}`, (a, b) => `${a}; ${b}`, (a, b) => `${a}\n${b}`]) {
    ALL_PRIVATE.push(join(setter, INSTALL[eco]));
  }
}
ALL_PRIVATE.push(...INLINE_AND_CHAINED, ...READS);

for (const cmd of ALL_PRIVATE) {
  test('no lookup for another registry form: ' + JSON.stringify(cmd), async () => {
    assert.deepEqual(await askedFor(cmd), []);
  });
}

test('no lookup at all for any of the private forms, and no request is made', async () => {
  let calls = 0;
  const fetch = () => { calls++; throw new Error('the public registry must not be asked'); };
  for (const cmd of ALL_PRIVATE) {
    const r = await pc.check(cmd, { mode: 'online', lookup: (items) => reg.lookupMany(items, { fetch }) });
    assert.deepEqual(r.unavailable, [], cmd);
    assert.ok(!r.findings.some((f) => f.kind === 'not_found'), cmd);
  }
  assert.equal(calls, 0);
});

// Other commands that used to be read as public: they are not plain, so they are not looked up either. Their names
// stay in the offline check.
const NOT_PLAIN_BUT_PUBLIC = [
  'export FOO=1 && pip install requests',
  'FOO=1; pip install requests',
  'pip config list && pip install requests',
  'npm config set loglevel warn && npm i lodash',
  'echo hello > notes.txt && npm i corp-internal',
  'setx FOO bar && pip install requests',
  '$env:FOO = "x"; pip install requests',
];

for (const cmd of NOT_PLAIN_BUT_PUBLIC) {
  test('not plain, so not looked up (offline names still read): ' + JSON.stringify(cmd), async () => {
    assert.ok(pc.installsOf(cmd).length >= 1, 'a name was read');
    assert.deepEqual(await askedFor(cmd), []);
  });
}

test('privateRegistry reads BUN_CONFIG_REGISTRY and YARN_REGISTRY from the environment', () => {
  assert.equal(reg.privateRegistry('npm', { env: { BUN_CONFIG_REGISTRY: N } }), true);
  assert.equal(reg.privateRegistry('npm', { env: { YARN_REGISTRY: N } }), true);
  assert.equal(reg.privateRegistry('npm', { env: {} }), false);
});

test('uv value flags are not read as package names', () => {
  assert.deepEqual(pc.installsOf('uv add --project sub requests').map((i) => i.name), ['requests']);
  assert.deepEqual(pc.installsOf('uv pip install --index-strategy unsafe-best-match --python-platform linux requests').map((i) => i.name), ['requests']);
});

test('an inline assignment of any variable makes the line not plain: offline names are still read', async () => {
  assert.deepEqual(await askedFor('FOO=bar pip install requests'), []);
  assert.deepEqual(pc.installsOf('FOO=bar pip install requests').map((i) => i.name), ['requests']);
});
