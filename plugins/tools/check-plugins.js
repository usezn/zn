#!/usr/bin/env node
'use strict';

/**
 * Consistency and pinning checks for the agent plugins and the MCP registry
 * entry. Run from the repository root:
 *
 *   node plugins/tools/check-plugins.js            # every commit (CI)
 *   node plugins/tools/check-plugins.js --release  # before tagging a release
 *
 * Checks:
 *  - every JSON file parses;
 *  - one zn-gate version everywhere: the plugin manifests, the lock file, the
 *    MCP registry server.json and its npm package entry;
 *  - packages/zn-gate/package.json "mcpName" equals the server.json name;
 *  - the Agent Plugins manifest and mcp.json use only the fields of
 *    Agent Plugins 1.0;
 *  - no unpinned installs: no "@latest", no npx/bunx/uvx/pnpm dlx in the
 *    plugin, and every zn-gate install instruction names an exact version;
 *  - every hook and MCP server runs scripts/zn-launch.js;
 *  - --release: the lock file has the npm integrity, a provenance attestation
 *    and the file digests, and no placeholder is left in the plugin docs.
 * No dependencies; Node.js 18 or later.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PLUGIN = 'plugins/zn-gate';
const release = process.argv.includes('--release');
const errors = [];

function fail(msg) { errors.push(msg); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function json(rel) {
  try {
    return JSON.parse(read(rel));
  } catch (err) {
    fail(rel + ': ' + err.message);
    return {};
  }
}

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).flatMap((n) => walk(path.posix.join(rel, n)));
}

const files = [...walk('plugins'), '.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
for (const f of files) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(f + ': missing');
  else if (f.endsWith('.json')) json(f);
}

/* ---------------------------- versions ---------------------------- */

const lock = json(PLUGIN + '/scripts/zn-gate.lock.json');
const v = lock.version;
const server = json('plugins/mcp-registry/server.json');
const versions = {
  'plugin.json': json(PLUGIN + '/plugin.json').version,
  '.claude-plugin/plugin.json': json(PLUGIN + '/.claude-plugin/plugin.json').version,
  '.cursor-plugin/plugin.json': json(PLUGIN + '/.cursor-plugin/plugin.json').version,
  'server.json version': server.version,
  'server.json package version': ((server.packages || [])[0] || {}).version,
};
for (const [where, got] of Object.entries(versions)) {
  if (got !== v) fail(where + ': version ' + got + ' differs from the lock file version ' + v);
}
if (!/^\d+\.\d+\.\d+$/.test(v || '')) fail('lock file: version must be an exact release, got ' + v);

const pkg = json('packages/zn-gate/package.json');
if (pkg.mcpName !== server.name) fail('packages/zn-gate/package.json mcpName ' + pkg.mcpName + ' differs from server.json name ' + server.name);
const npmPkg = (server.packages || [])[0] || {};
if (npmPkg.registryType !== 'npm' || npmPkg.identifier !== 'zn-gate') fail('server.json: first package must be the npm package zn-gate');
if (npmPkg.registryBaseUrl && npmPkg.registryBaseUrl !== 'https://registry.npmjs.org') fail('server.json: registryBaseUrl must be https://registry.npmjs.org');

/* ------------------------- Agent Plugins 1.0 ------------------------- */

const AP_FIELDS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
const ap = json(PLUGIN + '/plugin.json');
if (ap.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') fail('plugin.json: $schema must be the Agent Plugins 1.0.0 identifier');
for (const k of Object.keys(ap)) if (!AP_FIELDS.has(k)) fail('plugin.json: field ' + k + ' is not part of Agent Plugins 1.0');
if (!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(ap.name || '')) fail('plugin.json: invalid name');
const apMcp = json(PLUGIN + '/mcp.json');
if (apMcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') fail('mcp.json: $schema must be the Agent Plugins 1.0.0 identifier');
for (const k of Object.keys(apMcp)) if (!['$schema', 'mcpServers'].includes(k)) fail('mcp.json: unexpected field ' + k);

/* ------------------------ what the plugin runs ------------------------ */

const LAUNCHER = /^node "?(\$\{CLAUDE_PLUGIN_ROOT\}\/|\$PLUGIN_ROOT\/|\.\/)scripts\/zn-launch\.js"? (hook (claude-code|codex|cursor)|check claude-code)$/;
function hookCommands(data) {
  const out = [];
  for (const groups of Object.values((data && data.hooks) || {})) {
    for (const g of groups) {
      if (Array.isArray(g.hooks)) g.hooks.forEach((h) => out.push(h.command));
      else out.push(g.command);
    }
  }
  return out;
}
for (const f of ['hooks/hooks.json', 'com.openai/hooks.json', 'cursor/hooks.json']) {
  const cmds = hookCommands(json(PLUGIN + '/' + f));
  if (cmds.length === 0) fail(f + ': no hooks');
  for (const c of cmds) if (!LAUNCHER.test(String(c))) fail(f + ': hook command does not run the launcher: ' + c);
}
for (const [f, root] of [['mcp.json', '${PLUGIN_ROOT}'], ['.mcp.json', '${CLAUDE_PLUGIN_ROOT}'], ['cursor/mcp.json', '${CURSOR_PLUGIN_ROOT}']]) {
  for (const [name, s] of Object.entries(json(PLUGIN + '/' + f).mcpServers || {})) {
    if (s.command !== 'node' || JSON.stringify(s.args) !== JSON.stringify([root + '/scripts/zn-launch.js', 'secrets-mcp'])) {
      fail(f + ': MCP server ' + name + ' does not run the launcher');
    }
  }
}

const cursorManifest = json(PLUGIN + '/.cursor-plugin/plugin.json');
if (cursorManifest.hooks !== './cursor/hooks.json' || cursorManifest.mcpServers !== './cursor/mcp.json') {
  fail('.cursor-plugin/plugin.json: hooks and mcpServers must point to the Cursor files in cursor/');
}
for (const [event, entries] of Object.entries(json(PLUGIN + '/cursor/hooks.json').hooks || {})) {
  for (const e of entries) if (e.failClosed !== true) fail('cursor/hooks.json: ' + event + ' hook is not failClosed');
}

/* ------------------------------- links ------------------------------- */

// Links into this repository name the release tag and a path that exists.
for (const f of files.filter((x) => /\.(md|json)$/.test(x) && fs.existsSync(path.join(ROOT, x)))) {
  const re = /https:\/\/github\.com\/usezn\/zn\/(?:blob|tree)\/([^/\s)"']+)\/([^\s)"'#]+)/g;
  let m;
  const text = read(f);
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== 'v' + v) fail(f + ': link to ' + m[0] + ' must use the tag v' + v);
    const target = m[2].replace(/[.,;:]+$/, '');
    if (!fs.existsSync(path.join(ROOT, ...target.split('/')))) fail(f + ': link to ' + m[0] + ' names a path that does not exist');
  }
}

/* ------------------------------ pinning ------------------------------ */

const UNPINNED = [
  [/@latest\b/, '"@latest"'],
  [/\b(npx|bunx|uvx|pnpm dlx|yarn dlx|pipx run)\b/, 'a package launcher'],
];
for (const f of walk(PLUGIN)) {
  const text = read(f);
  for (const [re, what] of UNPINNED) if (re.test(text)) fail(f + ': contains ' + what);
}
for (const f of walk('plugins').filter((x) => x.endsWith('.md'))) {
  const text = read(f);
  const installs = text.match(/(npm (install|i) (-g |--global )?zn-gate[^\s`]*|npx (-y )?zn-gate[^\s`]*)/g) || [];
  for (const m of installs) {
    if (!/zn-gate@(\d+\.\d+\.\d+|X\.Y\.Z)$/.test(m)) fail(f + ': install without an exact version: ' + m);
    else if (!m.endsWith('@' + v) && !m.endsWith('X.Y.Z')) fail(f + ': install pins ' + m + ', not ' + v);
  }
  const uses = text.match(/uses: [^\s]+/g) || [];
  for (const u of uses) if (!/@([0-9a-f]{40}|<commit-sha-of-v\d+\.\d+\.\d+>)$/.test(u)) fail(f + ': action not pinned by commit SHA: ' + u);
}

/* ------------------------------ release ------------------------------ */

if (release) {
  if (!/^sha512-/.test(lock.integrity || '')) fail('lock file: no npm integrity; run plugins/tools/pin-release.js ' + v);
  if (Object.keys(lock.files || {}).length === 0) fail('lock file: no file digests; run plugins/tools/pin-release.js ' + v);
  if (lock.attestations !== true) fail('lock file: zn-gate ' + v + ' has no npm provenance attestation; publish it with provenance first');
  for (const f of walk('plugins').filter((x) => x.endsWith('.md'))) {
    if (/<commit-sha-of-v[^>]*>/.test(read(f))) fail(f + ': replace the <commit-sha-of-v...> placeholder with the release commit SHA');
  }
}

if (errors.length) {
  process.stderr.write(errors.map((e) => 'check-plugins: ' + e).join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('check-plugins: OK (zn-gate ' + v + (release ? ', release mode' : '') + ')\n');
}
