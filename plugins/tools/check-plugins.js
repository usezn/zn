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
 *  - one zn-gate version everywhere: the plugin manifests and the lock file;
 *  - the MCP Registry entry is one file, packages/zn-gate/server.json (the one the
 *    mcp-registry workflow publishes): no other server.json in the repository,
 *    its version equals packages/zn-gate/package.json (and, with --release, the
 *    lock file), and "mcpName" in package.json equals its name;
 *  - the Agent Plugins manifest and mcp.json use only the fields of
 *    Agent Plugins 1.0;
 *  - no unpinned installs: no "@latest", no npx/bunx/uvx/pnpm dlx in the
 *    plugin, and every zn-gate install instruction names an exact version;
 *  - every hook and MCP server runs scripts/zn-launch.js, and the MCP servers
 *    are exactly zn-gate (local rules only) and secrets;
 *  - package.json / package-lock.json, when present, pin the same release;
 *  - --release: the lock file has the npm integrity, a provenance attestation
 *    and the file digests, the npm files exist, and no placeholder is left in
 *    the plugin docs.
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
const SERVER_JSON = 'packages/zn-gate/server.json';
const server = json(SERVER_JSON);
const serverPkgs = (server.packages || []).filter((p) => p && p.identifier === 'zn-gate');
const versions = {
  'plugin.json': json(PLUGIN + '/plugin.json').version,
  '.claude-plugin/plugin.json': json(PLUGIN + '/.claude-plugin/plugin.json').version,
  '.cursor-plugin/plugin.json': json(PLUGIN + '/.cursor-plugin/plugin.json').version,
  'plugins/zcode/.zcode-plugin/plugin.json': json('plugins/zcode/.zcode-plugin/plugin.json').version,
};
for (const [where, got] of Object.entries(versions)) {
  if (got !== v) fail(where + ': version ' + got + ' differs from the lock file version ' + v);
}
if (!/^\d+\.\d+\.\d+$/.test(v || '')) fail('lock file: version must be an exact release, got ' + v);

const pkg = json('packages/zn-gate/package.json');
if (pkg.mcpName !== server.name) fail('packages/zn-gate/package.json mcpName ' + pkg.mcpName + ' differs from ' + SERVER_JSON + ' name ' + server.name);
// The registry entry follows the published package, not the plugin pin: on next the pin can lag a release.
const serverVersions = { [SERVER_JSON + ' version']: server.version };
serverPkgs.forEach((p, i) => { serverVersions[SERVER_JSON + ' package version ' + (i + 1)] = p.version; });
// A prerelease (X.Y.Z-rc.N) is not pinned in the plugin: the pin stays on the last final, older than X.Y.Z.
const pre = /^(\d+\.\d+\.\d+)-(?:alpha|beta|rc)\.\d+$/.exec(pkg.version || '');
const olderFinal = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
for (const [where, got] of Object.entries(serverVersions)) {
  if (got !== pkg.version) fail(where + ': version ' + got + ' differs from packages/zn-gate/package.json version ' + pkg.version);
  if (release && !pre && got !== v) fail(where + ': version ' + got + ' differs from the lock file version ' + v);
}
if (release && pre && !olderFinal(v || '0.0.0', pre[1])) {
  fail('lock file: for the prerelease ' + pkg.version + ' the plugin pin must stay on the last final release (older than ' + pre[1] + '), got ' + v);
}
if (serverPkgs.length !== 1) fail(SERVER_JSON + ': expected exactly one npm package entry for zn-gate, found ' + serverPkgs.length);
const npmPkg = serverPkgs[0] || {};
if (npmPkg.registryType !== 'npm') fail(SERVER_JSON + ': the zn-gate package entry must have registryType npm');
if (npmPkg.registryBaseUrl && npmPkg.registryBaseUrl !== 'https://registry.npmjs.org') fail(SERVER_JSON + ': registryBaseUrl must be https://registry.npmjs.org');

// One registry entry: a second server.json with the same name but other content is what this guards against.
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'out', 'dist']);
function serverJsonFiles(rel) {
  const abs = path.join(ROOT, rel);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : serverJsonFiles(r);
    return e.name === 'server.json' ? [r] : [];
  });
}
for (const f of serverJsonFiles('.')) {
  if (f !== SERVER_JSON) fail(f + ': the MCP Registry entry is ' + SERVER_JSON + ' only; remove this file or give it another name and purpose');
}
const registryWorkflow = '.github/workflows/mcp-registry.yml';
if (fs.existsSync(path.join(ROOT, registryWorkflow)) && !read(registryWorkflow).includes(SERVER_JSON)) {
  fail(registryWorkflow + ': it must publish ' + SERVER_JSON);
}

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
// Each MCP server and the launcher mode that starts it (zn-gate-mcp uses local
// rules unless the Claude Code plugin's optional api_key option is set).
const MCP_MODES = { 'zn-gate': 'zn-gate-mcp', secrets: 'secrets-mcp' };
// The only environment a server may get: the Claude Code key option, for zn-gate.
const MCP_ENV = { '.mcp.json': { 'zn-gate': { ZN_PLUGIN_API_KEY: '${user_config.api_key}' } } };
for (const [f, root] of [['mcp.json', '${PLUGIN_ROOT}'], ['.mcp.json', '${CLAUDE_PLUGIN_ROOT}'], ['cursor/mcp.json', '${CURSOR_PLUGIN_ROOT}']]) {
  const servers = json(PLUGIN + '/' + f).mcpServers || {};
  if (JSON.stringify(Object.keys(servers).sort()) !== JSON.stringify(Object.keys(MCP_MODES).sort())) {
    fail(f + ': MCP servers must be exactly ' + Object.keys(MCP_MODES).join(', '));
  }
  for (const [name, s] of Object.entries(servers)) {
    const env = (MCP_ENV[f] || {})[name];
    const envOk = env ? JSON.stringify(s.env) === JSON.stringify(env) : !s.env;
    // Only the Claude Code zn-gate server is started as "claude-code" (it may use the key option).
    const args = [root + '/scripts/zn-launch.js', MCP_MODES[name]].concat(env ? ['claude-code'] : []);
    if (s.command !== 'node' || JSON.stringify(s.args) !== JSON.stringify(args) || !envOk) {
      fail(f + ': MCP server ' + name + ' does not run the launcher in ' + MCP_MODES[name] + ' mode');
    }
  }
}

// The listing icon named in the Claude Code manifest exists inside the plugin, outside .claude-plugin/.
{
  const icon = json(PLUGIN + '/.claude-plugin/plugin.json').icon;
  if (icon !== undefined && (typeof icon !== 'string' || !/^\.\/[\w.-]+\.png$/.test(icon) || !fs.existsSync(path.join(PLUGIN, icon)))) {
    fail('.claude-plugin/plugin.json: icon must name a PNG file at the plugin root that exists');
  }
}

// Claude Code plugin options: only the optional API key, kept as a sensitive value.
const claudeUserConfig = json(PLUGIN + '/.claude-plugin/plugin.json').userConfig || {};
for (const [k, v] of Object.entries(claudeUserConfig)) {
  if (k !== 'api_key') fail('.claude-plugin/plugin.json: unexpected userConfig option ' + k);
  else if (v.type !== 'string' || !v.title || !v.description || v.sensitive !== true || v.required !== false || v.default !== '') {
    fail('.claude-plugin/plugin.json: userConfig api_key must be a string option with a title and description, sensitive, optional and empty by default');
  }
}
if (JSON.stringify(json(PLUGIN + '/.mcp.json')).includes('${user_config.api_key}') && !claudeUserConfig.api_key) {
  fail('.mcp.json: uses ${user_config.api_key} but .claude-plugin/plugin.json has no api_key option');
}
// Plugin options never go to hooks (Claude Code exports them to hook processes anyway; the launcher drops them).
for (const f of ['hooks/hooks.json', 'com.openai/hooks.json', 'cursor/hooks.json']) {
  if (fs.readFileSync(PLUGIN + '/' + f, 'utf8').includes('${user_config')) fail(f + ': hooks must not use plugin options');
}

const cursorManifest = json(PLUGIN + '/.cursor-plugin/plugin.json');
if (cursorManifest.hooks !== './cursor/hooks.json' || cursorManifest.mcpServers !== './cursor/mcp.json') {
  fail('.cursor-plugin/plugin.json: hooks and mcpServers must point to the Cursor files in cursor/');
}
// Cursor blocks a failClosed hook that writes no output, and zn writes no output on shell, MCP and tool-use
// events when it has no objection (an "allow" there could skip Cursor's own approval). So only the events
// where zn always answers may fail closed: the same two as `zn hooks install cursor`.
for (const [event, entries] of Object.entries(json(PLUGIN + '/cursor/hooks.json').hooks || {})) {
  const mustClose = event === 'beforeReadFile' || event === 'beforeSubmitPrompt';
  for (const e of entries) {
    if (mustClose && e.failClosed !== true) fail('cursor/hooks.json: ' + event + ' hook is not failClosed');
    if (!mustClose && e.failClosed === true) fail('cursor/hooks.json: ' + event + ' hook is failClosed, but zn answers nothing there when it has no objection (Cursor would block every call)');
  }
}
// A hook on a blocking event that cannot run must block, not let the call or prompt through.
{
  const events = (json(PLUGIN + '/hooks/hooks.json').hooks || {});
  for (const event of ['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion']) {
    const hooks = (events[event] || []).flatMap((g) => (g && g.hooks) || []);
    if (!hooks.length) fail('hooks/hooks.json: no ' + event + ' hook');
    for (const h of hooks) if (h.onFailure !== 'block') fail('hooks/hooks.json: ' + event + ' hook is not onFailure "block"');
  }
}

/* ----------------------------- ZCode plugin ----------------------------- */

// The ZCode plugin has its own tree (ZCode always loads hooks/hooks.json of the plugin root, so the Claude Code hooks cannot be
// shared). Every hook runs scripts/zn-hook.sh with its own event name; the script runs the launcher in "hook zcode" mode.
{
  const ZC = 'plugins/zcode';
  const zhooks = (json(ZC + '/hooks/hooks.json').hooks) || {};
  const EVENTS = ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit'];
  if (JSON.stringify(Object.keys(zhooks).sort()) !== JSON.stringify(EVENTS)) fail(ZC + '/hooks/hooks.json: events must be exactly ' + EVENTS.join(', '));
  for (const [event, groups] of Object.entries(zhooks)) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        const args = JSON.stringify(h.args);
        if (h.type !== 'process' || h.command !== 'sh' || args !== JSON.stringify(['${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh', event])) {
          fail(ZC + '/hooks/hooks.json: ' + event + ' hook must be a process hook: sh ${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh ' + event);
        }
        if (h.onFailure !== undefined || h.async !== undefined) fail(ZC + '/hooks/hooks.json: ' + event + ' hook must not set onFailure or async');
      }
    }
  }
  const zm = json(ZC + '/.zcode-plugin/plugin.json');
  if (zm.name !== 'zn-gate') fail(ZC + '/.zcode-plugin/plugin.json: name must be zn-gate');
  for (const k of ['hooks', 'mcpServers', 'userConfig']) {
    if (zm[k] !== undefined) fail(ZC + '/.zcode-plugin/plugin.json: no "' + k + '" key (the hooks file is found by name; there is nothing to configure)');
  }
  const mk = json(ZC + '/marketplace.json');
  const entry = (mk.plugins || [])[0] || {};
  if ((mk.plugins || []).length !== 1 || entry.name !== 'zn-gate' || entry.source !== './zn-gate') fail(ZC + '/marketplace.json: one plugin, zn-gate, with source ./zn-gate');
  if (!fs.readFileSync(path.join(ROOT, ZC, 'scripts', 'zn-hook.sh'), 'utf8').includes('hook zcode')) fail(ZC + '/scripts/zn-hook.sh: must run the launcher in "hook zcode" mode');
}

/* -------------------------- Antigravity CLI plugin -------------------------- */

// The Antigravity plugin has its own tree: plugin.json and hooks.json at its root (plugin.json takes no version key, so the
// pin is the lock file of the build). One PreToolUse hook runs scripts/zn-hook.sh, which runs the launcher in "hook antigravity" mode.
{
  const AG = 'plugins/antigravity';
  const am = json(AG + '/plugin.json');
  if (am.name !== 'zn-gate') fail(AG + '/plugin.json: name must be zn-gate');
  for (const k of Object.keys(am)) {
    if (!['name', 'description', '$schema'].includes(k)) fail(AG + '/plugin.json: no "' + k + '" key (Antigravity accepts only name, description and $schema)');
  }
  const ah = json(AG + '/hooks.json');
  const named = Object.keys(ah);
  if (named.length !== 1 || named[0] !== 'zn-gate') fail(AG + '/hooks.json: exactly one named hook, zn-gate');
  const entry = ah['zn-gate'] || {};
  const events = Object.keys(entry).filter((k) => k !== 'enabled');
  if (JSON.stringify(events) !== JSON.stringify(['PreToolUse'])) fail(AG + '/hooks.json: the only event is PreToolUse');
  for (const g of entry.PreToolUse || []) {
    for (const h of g.hooks || []) {
      if (h.type !== 'command' || h.command !== 'sh scripts/zn-hook.sh') fail(AG + '/hooks.json: the PreToolUse hook must be a command hook: sh scripts/zn-hook.sh');
      if (!(Number.isInteger(h.timeout) && h.timeout > 0 && h.timeout < 30)) fail(AG + '/hooks.json: the hook needs a timeout below the 30 seconds default');
    }
  }
  if (!fs.readFileSync(path.join(ROOT, AG, 'scripts', 'zn-hook.sh'), 'utf8').includes('hook antigravity')) fail(AG + '/scripts/zn-hook.sh: must run the launcher in "hook antigravity" mode');
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

/* ----------------------- npm install for Claude Code ----------------------- */

// Claude Code installs the plugin's dependencies from package.json and
// package-lock.json (written by pin-release.js). When they exist they must
// pin the same zn-gate release, from the registry, with no inBundle entries.
const npmPkgFile = PLUGIN + '/package.json';
const npmLockFile = PLUGIN + '/package-lock.json';
const hasNpm = fs.existsSync(path.join(ROOT, npmPkgFile)) || fs.existsSync(path.join(ROOT, npmLockFile));
if (hasNpm) {
  const npmPkg = json(npmPkgFile);
  const npmLock = json(npmLockFile);
  const pkgs = npmLock.packages || {};
  const z = pkgs['node_modules/zn-gate'] || {};
  if ((npmPkg.dependencies || {})['zn-gate'] !== v) fail(npmPkgFile + ': must depend on zn-gate ' + v + ' exactly');
  if (npmPkg.scripts) fail(npmPkgFile + ': must have no scripts');
  // Dependencies: zn-gate and the top-level packages bundled in its tarball,
  // at their bundled versions; the same list in the root of the npm lock.
  const bundledTop = Object.keys(lock.files || {})
    .map((f) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(f)).filter(Boolean).map((m) => m[1]).sort();
  const wantDeps = ['zn-gate', ...bundledTop].sort();
  const pkgDeps = Object.keys(npmPkg.dependencies || {}).sort();
  if (Object.keys(lock.files || {}).length && JSON.stringify(pkgDeps) !== JSON.stringify(wantDeps)) {
    fail(npmPkgFile + ': dependencies must be exactly ' + wantDeps.join(', '));
  }
  if (JSON.stringify((pkgs[''] || {}).dependencies || {}) !== JSON.stringify(npmPkg.dependencies || {})) {
    fail(npmLockFile + ': root dependencies differ from ' + npmPkgFile);
  }
  if (z.version !== v || z.integrity !== lock.integrity) fail(npmLockFile + ': must pin zn-gate ' + v + ' with the integrity in the lock file');
  for (const [k, e] of Object.entries(pkgs)) {
    if (!k) continue;
    if (e.inBundle || k.startsWith('node_modules/zn-gate/')) fail(npmLockFile + ': ' + k + ' is a bundled entry (Claude Code rejects those)');
    if (e.hasInstallScript) fail(npmLockFile + ': ' + k + ' has an install script');
    if (!/^sha512-/.test(e.integrity || '') || !String(e.resolved || '').startsWith('https://registry.npmjs.org/')) fail(npmLockFile + ': ' + k + ' has no sha512 integrity or registry URL');
  }
}

/* ------------------------ Codex plugin layout ------------------------ */

// Codex (OpenAI docs, "Package your plugin"): the root plugin.json is the
// manifest, its OpenAI settings live under extensions["com.openai"], and the
// repository marketplace is .agents/plugins/marketplace.json, whose plugin
// entries need source.path (./ prefixed, inside the marketplace root),
// policy.installation, policy.authentication and category.
const codexExt = ap.extensions || {};
// Other keys under extensions and extensions.com.openai (presentation, apps,
// onboardingSkill, MCP server mappings) are documented by OpenAI and not checked here.
const codexOpenAI = codexExt['com.openai'] || {};
if (codexOpenAI.hooks !== './com.openai/hooks.json') fail(PLUGIN + '/plugin.json: extensions.com.openai.hooks must be ./com.openai/hooks.json');
if (!fs.existsSync(path.join(ROOT, PLUGIN, 'com.openai', 'hooks.json'))) fail(PLUGIN + '/com.openai/hooks.json: missing');
const codexMarket = json('.agents/plugins/marketplace.json');
const CODEX_INSTALL = new Set(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']);
const codexEntries = (codexMarket.plugins || []).filter((p) => p.name === ap.name);
if (codexEntries.length !== 1) {
  fail('.agents/plugins/marketplace.json: needs exactly one entry named ' + ap.name);
} else {
  const e = codexEntries[0];
  const src = e.source || {};
  if (src.path !== './' + PLUGIN) fail('.agents/plugins/marketplace.json: source.path must be ./' + PLUGIN);
  if (!CODEX_INSTALL.has((e.policy || {}).installation)) fail('.agents/plugins/marketplace.json: policy.installation must be AVAILABLE, INSTALLED_BY_DEFAULT or NOT_AVAILABLE');
  if (!(e.policy || {}).authentication) fail('.agents/plugins/marketplace.json: policy.authentication is required');
  if (!e.category) fail('.agents/plugins/marketplace.json: category is required');
}

/* ------------------------------ release ------------------------------ */

if (release) {
  if (!hasNpm) fail(npmPkgFile + ' and ' + npmLockFile + ' are missing; run plugins/tools/pin-release.js ' + v);
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
