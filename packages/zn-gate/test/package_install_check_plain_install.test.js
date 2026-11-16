'use strict';

process.env.ZN_STATS = 'off';

// Package install check, online allow list: only a whole command line that is a plain install may send its names to the
// public registry. Everything else is checked offline and sends nothing. No network: the lookup is a spy.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');

const PYPI_URL = 'https://pypi.corp.example.invalid/simple';
const NPM_URL = 'https://npm.corp.example.invalid';
const PUBLIC_NAME = 'my-invented-package';

// The names the online lookup is asked for, in the order asked. The spy answers "no information" for each.
async function askedFor(command) {
  const asked = [];
  await pc.check(command, {
    mode: 'online',
    lookup: async (items) => { asked.push(...items.map((i) => i.name)); return new Map(); },
  });
  return asked;
}

/* ------------------------------- plain installs are looked up ------------------------------- */

const PLAIN = [
  `npm install ${PUBLIC_NAME}`,
  `npm i -D ${PUBLIC_NAME}`,
  `npm add --save-exact ${PUBLIC_NAME}@1.2.3`,
  `npm i --no-audit --no-fund ${PUBLIC_NAME}`,
  `pnpm add -g ${PUBLIC_NAME}`,
  `pnpm install ${PUBLIC_NAME}`,
  `yarn add ${PUBLIC_NAME}`,
  `yarn global add ${PUBLIC_NAME}`,
  `bun add ${PUBLIC_NAME}`,
  `npm install "${PUBLIC_NAME}"`,
  `pip install ${PUBLIC_NAME}`,
  `pip3 install --user --no-deps ${PUBLIC_NAME}==1.0`,
  `python -m pip install -U ${PUBLIC_NAME}`,
  `py -m pip install --quiet ${PUBLIC_NAME}`,
  `pip install ${PUBLIC_NAME}[socks]`,
  `uv pip install ${PUBLIC_NAME}`,
  `uv add --dev ${PUBLIC_NAME}`,
  `pipx install ${PUBLIC_NAME}`,
  `npm i ${PUBLIC_NAME} && pip install ${PUBLIC_NAME}`,
];

for (const cmd of PLAIN) {
  test('plain install is looked up: ' + JSON.stringify(cmd), async () => {
    assert.ok((await askedFor(cmd)).includes(PUBLIC_NAME), JSON.stringify(cmd));
  });
}

test('plain install: the names come from plainInstallNames, with the registry form of each', () => {
  const r = pc.plainInstallNames(`npm i ${PUBLIC_NAME}@^1.2 && pip install Flask_CORS==2.0`);
  assert.deepEqual(r.map((i) => [i.eco, i.name]), [['npm', PUBLIC_NAME], ['pypi', 'flask-cors']]);
});

test('plain install: a capital letter in an npm name is read but not looked up (legacy names)', async () => {
  assert.deepEqual(await askedFor('npm i My-Invented-Package'), []);
});

test('plain install: a look-alike is reported offline and never looked up', async () => {
  const r = await pc.check('npm i lodahs', { mode: 'online', lookup: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(r.findings.map((f) => f.kind), ['one_edit']);
});

/* ------------------------------- what is not plain ------------------------------- */

// Registry switches written next to their value, or abbreviated, or inside a
// quoted value of another tool. None is in the allow list, so none reaches the lookup.
const REVIEW_VARIANTS = [
  `pip install -i${PYPI_URL} ${PUBLIC_NAME}`,
  `pip install -qi ${PYPI_URL} ${PUBLIC_NAME}`,
  `pip install -f${PYPI_URL} ${PUBLIC_NAME}`,
  `pip install --ind ${PYPI_URL} ${PUBLIC_NAME}`,
  `pip install --extra-i ${PYPI_URL} ${PUBLIC_NAME}`,
  `pip install --find ${PYPI_URL} ${PUBLIC_NAME}`,
  `pipx install --pip-args "-i ${PYPI_URL}" ${PUBLIC_NAME}`,
  `npm i --reg ${NPM_URL} ${PUBLIC_NAME}`,
  `npm i --reg=${NPM_URL} ${PUBLIC_NAME}`,
  `pnpm add --regis ${NPM_URL} ${PUBLIC_NAME}`,
  `pnpm add --regis=${NPM_URL} ${PUBLIC_NAME}`,
];

for (const cmd of REVIEW_VARIANTS) {
  test('joined or abbreviated registry switch: nothing is looked up -> ' + JSON.stringify(cmd), async () => {
    assert.deepEqual(await askedFor(cmd), []);
  });
}

// Switches that are not in the closed list, joined switches, and switches that take a value.
const UNKNOWN_SWITCHES = [
  `npm i ${PUBLIC_NAME} --foo`,
  `npm i --prefix ./app ${PUBLIC_NAME}`,
  `npm i -w web ${PUBLIC_NAME}`,
  `npm i --save-prefix=~ ${PUBLIC_NAME}`,
  `npm i --userconfig ./corp.npmrc ${PUBLIC_NAME}`,
  `npm i --@corp:registry=${NPM_URL} ${PUBLIC_NAME}`,
  `npm i --config.registry=${NPM_URL} ${PUBLIC_NAME}`,
  `pip install -qU ${PUBLIC_NAME}`,
  `pip install -r requirements.txt`,
  `pip install -e . ${PUBLIC_NAME}`,
  `pip install -c constraints.txt ${PUBLIC_NAME}`,
  `pip install --index-url=${PYPI_URL} ${PUBLIC_NAME}`,
  `pip install --no-index --find-links ./wheels ${PUBLIC_NAME}`,
  `uv add --project sub ${PUBLIC_NAME}`,
  `uv add --index-strategy unsafe-best-match ${PUBLIC_NAME}`,
  `npm i ${PUBLIC_NAME} --`,
];

for (const cmd of UNKNOWN_SWITCHES) {
  test('unknown switch: nothing is looked up -> ' + JSON.stringify(cmd), async () => {
    assert.deepEqual(await askedFor(cmd), []);
  });
}

// Names that are not plain names: paths, URLs, aliases, globs, versions with operators.
const NOT_NAMES = [
  `npm i ./local-dir`,
  `npm i ../sibling`,
  `npm i /abs/path`,
  `npm i https://example.invalid/pkg.tgz`,
  `npm i github:user/repo`,
  `npm i ${PUBLIC_NAME}@npm:other-package`,
  `npm i user/repo`,
  `npm i ${PUBLIC_NAME}@file:../x`,
  `npm i $PKG`,
  `pip install git+https://example.invalid/pkg.git`,
  `pip install ./dist/pkg.whl`,
  `pip install ${PUBLIC_NAME}>=1`,
  `pip install ${PUBLIC_NAME}@https://example.invalid/pkg.whl`,
];

for (const cmd of NOT_NAMES) {
  test('not a plain name: nothing is looked up -> ' + JSON.stringify(cmd), async () => {
    assert.deepEqual(await askedFor(cmd), []);
  });
}

// The whole command must be the install: a wrapper, another command, a shell, a variable, a redirect, a pipe.
const NOT_PLAIN_COMMANDS = [
  `cd app && npm i ${PUBLIC_NAME}`,
  `echo hi && pip install ${PUBLIC_NAME}`,
  `npm i ${PUBLIC_NAME} && echo done`,
  `npm i ${PUBLIC_NAME}; echo done`,
  `sudo npm i ${PUBLIC_NAME}`,
  `env FOO=1 npm i ${PUBLIC_NAME}`,
  `FOO=1 npm i ${PUBLIC_NAME}`,
  `sh -c "npm i ${PUBLIC_NAME}"`,
  `(npm i ${PUBLIC_NAME})`,
  `{ npm i ${PUBLIC_NAME}; }`,
  `npm i ${PUBLIC_NAME} > install.log`,
  `npm i ${PUBLIC_NAME} 2>&1`,
  `npm i ${PUBLIC_NAME} | tee install.log`,
  `npm i ${PUBLIC_NAME} & `,
  `npm i ${PUBLIC_NAME}\nnpm i other-package`,
  `npm i ${PUBLIC_NAME} # note`,
  `npm i ${PUBLIC_NAME}*`,
  `npm i $(echo ${PUBLIC_NAME})`,
  'npm i `echo ' + PUBLIC_NAME + '`',
  `npx ${PUBLIC_NAME}`,
  `uvx ${PUBLIC_NAME}`,
  `pipx run ${PUBLIC_NAME}`,
  `npm config get registry && npm i ${PUBLIC_NAME}`,
  `export PIP_INDEX_URL=${PYPI_URL} && pip install ${PUBLIC_NAME}`,
  `pip install ${PUBLIC_NAME}; pip config list`,
  `npm i ${PUBLIC_NAME} && npm i other-package --registry ${NPM_URL}`,
];

for (const cmd of NOT_PLAIN_COMMANDS) {
  test('not a plain command: nothing is looked up -> ' + JSON.stringify(cmd), async () => {
    assert.deepEqual(await askedFor(cmd), []);
    assert.equal(pc.plainInstallNames(cmd), null, 'plainInstallNames says not plain');
  });
}

test('not plain: the offline check still reads the names', () => {
  assert.deepEqual(pc.installsOf(`cd app && npm i ${PUBLIC_NAME}`).map((i) => i.name), [PUBLIC_NAME]);
  assert.deepEqual(pc.installsOf(`sudo env npm i ${PUBLIC_NAME}`).map((i) => i.name), [PUBLIC_NAME]);
});

test('an install without a name is plain and asks nothing', async () => {
  assert.deepEqual(await askedFor('npm ci'), []);
  assert.deepEqual(pc.plainInstallNames('npm install'), []);
});

test('a registry URL given where a name belongs is never looked up', async () => {
  for (const cmd of [`npm i ${NPM_URL}`, `pip install ${PYPI_URL}`]) {
    assert.deepEqual(await askedFor(cmd), [], cmd);
  }
});
