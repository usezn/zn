'use strict';

/**
 * Optional check of the packages an agent installs by name (`npm install lodash`, `pip install requests`).
 *
 * Off by default. The agent hooks run it only when the user turns it on (`hooks.packageInstallCheck` in
 * ~/.zn/config.json, or ZN_PACKAGE_CHECK=offline in the environment). It never blocks: a name that needs a second
 * look makes the hook ask, and an agent that cannot ask just runs the command.
 *
 *   offline  compares each name with a bundled starter list of well-known names (lib/data/package-names.json) and
 *            reports a name that is one small step away from one of them: a one-letter change, two letters swapped,
 *            a look-alike character, other separators, or an npm scope that imitates a well-known scope.
 *            Needs no network and touches no file apart from that list.
 *   online   also asks the public registry (see package-registry.js) whether the name exists and how old it is.
 *
 * Only commands that install packages BY NAME are read: `npm|pnpm|yarn|bun add|install|i <name>`,
 * `pip|pip3 install <name>`, `python -m pip install <name>`, `uv pip install <name>`, `uv add <name>`,
 * `pipx install <name>`. One-off runs (`npx`, `uvx`, `pipx run`) are not read in this version. Installs without a
 * name (`npm ci`, `npm install`, `pip install -r file`, `-e .`, local paths, URLs, git sources, archives) are not
 * checked. The command is split with the hook policy's own tokenizer (scanFirstCommand).
 */

const { scanFirstCommand } = require('./hooks/policy');
const NAMES = require('./data/package-names.json');
const { newDaysOf } = require('./package-check-settings');

const MAX_CHARS = 100 * 1024;
const MAX_SEGMENTS = 200;
const MAX_NAMES = 24;
const MIN_LOOKALIKE_LENGTH = 5;

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const SUDO_ARG_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-U', '-D', '-R']);

// Flags that take the next word as their value, so that value is not read as a package name.
const NPM_VALUE_FLAGS = new Set(['--prefix', '--registry', '--tag', '--cache', '--userconfig', '--globalconfig', '--workspace', '--scope',
  '--otp', '--install-strategy', '--omit', '--include', '--loglevel', '--save-prefix', '--before', '--filter', '--dir', '--cwd',
  '--reporter', '--store-dir', '--lockfile-dir', '--virtual-store-dir', '--config', '--modules-folder', '--cache-folder',
  '--network-timeout', '--proxy', '--https-proxy', '--mutex', '--cache-dir', '--backend', '--concurrent-scripts', '-F', '-C']);
const PIP_VALUE_FLAGS = new Set(['-r', '--requirement', '--requirements', '-c', '--constraint', '--override', '-e', '--editable', '-i', '--index-url',
  '--extra-index-url', '--index', '--default-index', '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--src', '--python', '-p',
  '--platform', '--python-version', '--implementation', '--abi', '--only-binary', '--no-binary', '--global-option', '--install-option',
  '--config-settings', '-C', '--progress-bar', '--cache-dir', '--upgrade-strategy', '--report', '--trusted-host', '--proxy', '--retries',
  '--timeout', '--exists-action', '--cert', '--client-cert', '--log', '--use-feature', '--use-deprecated', '--root-user-action',
  '--keyring-provider', '--resolution', '--python-preference', '--link-mode', '--group', '--optional', '--package', '--extra', '--suffix',
  '--pip-args', '--spec', '--constraints',
  // uv flags that take a value (their value is a folder, a mode or a pin, never a package name)
  '--index-strategy', '--project', '--directory', '--prerelease', '--python-platform', '--torch-backend', '--bounds', '--rev', '--tag',
  '--branch', '--marker', '-m', '--config-file']);
// A command that names another registry: the public registry is never asked about its packages.
// (--userconfig, --globalconfig, --config-file name a settings file zn-gate does not read: treated as another registry.)
const NPM_REGISTRY_RE = /^--(?:(?:@[^=\s]+:)?registry|config\.registry|userconfig|globalconfig)(?:=|$)/;
const PIP_REGISTRY_RE = /^(?:--index-url|-i|--extra-index-url|--index|--default-index|-f|--find-links|--config-file)(?:=|$)/;
// Settings a command can carry in front of it (`VAR=x pip install y`, `env VAR=x ...`) that name another registry or a
// settings file. The value must not be empty.
const REGISTRY_ASSIGN_RE = /^(?:npm_config_(?:@[^=\s]+:)?registry|npm_config_(?:user|global)config|yarn_npm_registry_server|pip_(?:index_url|extra_index_url|find_links|config_file)|uv_(?:index(?:_url)?|index_[a-z0-9_]+|default_index|extra_index_url|find_links|config_file))=./i;

const NPM_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_SUBCOMMANDS = new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal']);
const PIP_HEAD_RE = /^pip(?:3(?:\.\d+)?)?$/;
const PYTHON_HEAD_RE = /^(?:py|python(?:[23](?:\.\d+)?)?)$/;

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function programName(text) {
  return String(text).replace(/^\\+/, '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

/* Simple commands of a command line, as arrays of words. Same reading as the destructive-command check. */
function segmentsOf(cmd) {
  let rest = String(cmd).replace(/(\d*[<>]+)&(\d+|-)/g, '$1_$2').replace(/&>>?/g, '>').replace(/(^|[\s"'])([A-Za-z]:)\\(?=\s|$)/g, '$1$2/');
  const out = [];
  for (let guard = 0; rest.length && guard < MAX_SEGMENTS; guard++) {
    const scan = scanFirstCommand(rest, false);
    const sep = scan.operator;
    let adv = scan.end + 1;
    if (sep === '|' || sep === '&') {
      const next = rest[scan.end + 1];
      if (next === sep || (sep === '|' && next === '&')) adv++;
    }
    out.push(scan.words.map((w) => w.text));
    rest = rest.slice(adv);
  }
  return out;
}

/* The words of a command after wrappers that only run it (sudo, env, VAR=x, nohup, nice, time ...). */
function unwrap(args) {
  let i = 0;
  let registry = false;
  const seen = (w) => { if (REGISTRY_ASSIGN_RE.test(w)) registry = true; };
  for (let guard = 0; guard < 8 && i < args.length; guard++) {
    const a = args[i];
    if (ASSIGN_RE.test(a)) { seen(a); i++; continue; }
    const name = programName(a);
    if (name === 'sudo' || name === 'doas') {
      i++;
      while (i < args.length && args[i].startsWith('-')) { const f = args[i++]; if (SUDO_ARG_FLAGS.has(f)) i++; }
      continue;
    }
    if (name === 'env') {
      i++;
      while (i < args.length && (args[i].startsWith('-') || ASSIGN_RE.test(args[i]))) { const f = args[i++]; seen(f); if (f === '-u' || f === '-C' || f === '-S') i++; }
      continue;
    }
    if (name === 'command' || name === 'exec' || name === 'nohup' || name === 'time' || name === 'builtin' || name === 'setsid') {
      i++;
      while (i < args.length && args[i].startsWith('-')) i++;
      continue;
    }
    if (name === 'nice' || name === 'ionice') {
      i++;
      while (i < args.length && args[i].startsWith('-')) { const f = args[i++]; if (f === '-n' || f === '-c') i++; }
      continue;
    }
    if (name === 'timeout') {
      i++;
      while (i < args.length && args[i].startsWith('-')) i++;
      i++;
      continue;
    }
    break;
  }
  return { words: args.slice(i), registry };
}

/*
 * Reads the words after the sub-command: returns { names: [word], registry: bool, spec: bool }.
 * A flag that takes a value consumes it; a flag written --flag=value is one word. `names` are the words that are not flags.
 */
function positionals(args, valueFlags, registryRe) {
  const names = [];
  let registry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { for (let j = i + 1; j < args.length; j++) names.push(args[j]); break; }
    if (a.startsWith('-') && a.length > 1) {
      if (registryRe.test(a)) registry = true;
      if (valueFlags.has(a)) i++;
      continue;
    }
    names.push(a);
  }
  return { names, registry };
}

/* A registry name from an npm spec (`lodash`, `lodash@^4`, `@types/node@18`), or null when the spec is not a registry name. */
function npmNameOf(spec) {
  const s = String(spec);
  if (!s || s.length > 300 || /^[.~/\\-]/.test(s) || /[:\s]/.test(s) || /\.(?:tgz|tar|tar\.gz|zip)$/i.test(s)) return null;
  const m = s.startsWith('@') ? /^(@[^/@]+\/[^/@]+)(?:@.*)?$/.exec(s) : /^([^@/]+)(?:@.*)?$/.exec(s);
  if (!m) return null;
  const raw = m[1];
  const name = raw.toLowerCase();
  if (name.length > 214 || !NPM_NAME_RE.test(name)) return null;
  return { raw, name, legacyCase: raw !== name };
}

/* A registry name from a Python requirement (`requests`, `requests==2`, `pkg[extra]>=1`), or null. */
function pypiNameOf(spec) {
  const s = String(spec).split(';')[0].trim();
  if (!s || s.length > 300 || /^[.~/\\-]/.test(s)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*((?:[=<>!~][^@/\\:]*)?)$/.exec(s);
  if (!m) return null;
  const raw = m[1];
  if (!PYPI_NAME_RE.test(raw) || raw.length > 100 || /\.(?:whl|tgz|zip|tar|gz)$/i.test(raw)) return null;
  return { raw, name: pypiNormalise(raw), legacyCase: false };
}

/** PyPI's own normalisation: lowercase, runs of - _ . become one -. Two names equal after it are the same package. */
function pypiNormalise(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/*
 * The installs by name in a command: [{ eco: 'npm' | 'pypi', name, raw, legacyCase, registry }].
 * `registry` is true when the same command names another registry (--registry, --index-url ...).
 */
function installsOf(command, depth = 0) {
  const text = String(command == null ? '' : command);
  if (!text || text.length > MAX_CHARS || depth > 2) return [];
  const found = [];
  for (const seg of segmentsOf(text)) {
    const un = unwrap(seg);
    const words = un.words;
    if (!words.length) continue;
    // An inline registry variable means the names come from another registry: never ask the public one.
    const start = found.length;
    const mark = () => { if (un.registry) for (let k = start; k < found.length; k++) found[k] = { ...found[k], registry: true }; };
    const head = programName(words[0]);
    const rest = words.slice(1);
    if (SHELLS.has(head)) {
      const c = rest.findIndex((w) => /^-[A-Za-z]*c$/.test(w));
      if (c >= 0 && typeof rest[c + 1] === 'string') found.push(...installsOf(rest[c + 1], depth + 1));
      mark();
      continue;
    }
    if (NPM_HEADS.has(head)) { found.push(...npmInstalls(head, rest)); mark(); continue; }
    if (PIP_HEAD_RE.test(head)) { found.push(...pipInstalls(rest)); mark(); continue; }
    if (PYTHON_HEAD_RE.test(head)) {
      const m = rest.indexOf('-m');
      if (m >= 0 && rest[m + 1] === 'pip') found.push(...pipInstalls(rest.slice(m + 2)));
      mark();
      continue;
    }
    if (head === 'uv') { found.push(...uvInstalls(rest)); mark(); continue; }
    if (head === 'pipx') {
      const sub = firstPositional(rest, PIP_VALUE_FLAGS);
      if (sub && sub.word === 'install' && !rest.includes('--spec')) found.push(...pypiList(rest.slice(sub.index + 1)));
      mark();
    }
  }
  return found.slice(0, MAX_NAMES);
}

/* The first word that is not a flag (or a flag's value): { word, index } or null. */
function firstPositional(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) { if (valueFlags.has(a)) i++; continue; }
    return { word: a, index: i };
  }
  return null;
}

function npmInstalls(head, args) {
  // npm's -w takes a workspace name; in pnpm and yarn it is a switch.
  const valueFlags = head === 'npm' ? new Set([...NPM_VALUE_FLAGS, '-w']) : NPM_VALUE_FLAGS;
  let sub = firstPositional(args, valueFlags);
  // yarn global add x
  if (sub && head === 'yarn' && sub.word === 'global') {
    const next = firstPositional(args.slice(sub.index + 1), valueFlags);
    sub = next && { word: next.word, index: sub.index + 1 + next.index };
  }
  if (!sub || !NPM_SUBCOMMANDS.has(sub.word)) return [];
  // yarn only adds by name with "add"; "yarn install" has no names.
  if (head === 'yarn' && sub.word !== 'add') return [];
  const { names, registry } = positionals(args.slice(sub.index + 1), valueFlags, NPM_REGISTRY_RE);
  const out = [];
  for (const w of names) {
    const n = npmNameOf(w);
    if (n) out.push({ eco: 'npm', ...n, registry: registry || args.some((a) => NPM_REGISTRY_RE.test(a)) });
  }
  return out;
}

function pypiList(args) {
  const { names, registry } = positionals(args, PIP_VALUE_FLAGS, PIP_REGISTRY_RE);
  const out = [];
  for (const w of names) {
    const n = pypiNameOf(w);
    if (n) out.push({ eco: 'pypi', ...n, registry });
  }
  return out;
}

function pipInstalls(args) {
  const sub = firstPositional(args, PIP_VALUE_FLAGS);
  if (!sub || sub.word !== 'install') return [];
  return pypiList(args.slice(sub.index + 1));
}

function uvInstalls(args) {
  const sub = firstPositional(args, PIP_VALUE_FLAGS);
  if (!sub) return [];
  if (sub.word === 'add') return pypiList(args.slice(sub.index + 1));
  if (sub.word === 'pip') {
    const next = firstPositional(args.slice(sub.index + 1), PIP_VALUE_FLAGS);
    if (next && next.word === 'install') return pypiList(args.slice(sub.index + 1 + next.index + 1));
  }
  return [];
}

/* ---------------------------- look-alike rules ---------------------------- */

const SEPARATORS_RE = /[-_.]/g;

/* A spelling that treats characters that are easy to confuse as one: rn = m, vv = w, 0 = o, 1 = l = i. */
function skeleton(s) {
  return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i]/g, 'l');
}

/* True when b is one edit away from a: a letter changed, added or removed, or two neighbouring letters swapped. */
function oneEdit(a, b) {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la < lb ? a.slice(i) === b.slice(i + 1) : b.slice(i) === a.slice(i + 1);
}

/* The index of a list of names: the set, the sorted array and the scopes of the npm names. */
function indexOf(list, eco) {
  const normalise = eco === 'pypi' ? pypiNormalise : (n) => String(n).toLowerCase();
  const all = [...new Set(list.map(normalise))].sort();
  const scopes = new Set();
  const unscoped = [];
  const scoped = [];
  for (const n of all) {
    if (eco === 'npm' && n.startsWith('@')) { scoped.push(n); scopes.add(n.slice(0, n.indexOf('/'))); } else unscoped.push(n);
  }
  return { eco, normalise, all: new Set(all), unscoped, scoped, scopes: [...scopes].sort() };
}

let DEFAULT_INDEX = null;
function defaultIndex() {
  if (!DEFAULT_INDEX) DEFAULT_INDEX = { npm: indexOf(NAMES.npm, 'npm'), pypi: indexOf(NAMES.pypi, 'pypi') };
  return DEFAULT_INDEX;
}

/* The spellings of a well-known name that are compared, worked out once (the list is fixed for the life of the process). */
const FORMS = new Map();
function formsOf(known) {
  let f = FORMS.get(known);
  if (!f) { f = { plain: known.replace(SEPARATORS_RE, ''), sk: skeleton(known) }; FORMS.set(known, f); }
  return f;
}

/* A well-known name in `candidates` that `name` imitates: { kind, with } or null. `name` is not in the list itself. */
function imitates(name, candidates) {
  if (name.length < MIN_LOOKALIKE_LENGTH) return null;
  const plain = name.replace(SEPARATORS_RE, '');
  const sk = skeleton(name);
  for (const known of candidates) {
    if (known.length < 4) continue;
    if (plain === formsOf(known).plain) return { kind: 'separators', with: known };
  }
  for (const known of candidates) {
    if (known.length >= MIN_LOOKALIKE_LENGTH && formsOf(known).sk === sk) return { kind: 'confusable', with: known };
  }
  for (const known of candidates) {
    if (oneEdit(name, known)) return { kind: 'one_edit', with: known };
  }
  return null;
}

/**
 * Does this name imitate a well-known one? Returns { kind, suggestion } or null.
 *   kind: 'separators' (same letters, other -, _ or .), 'confusable' (rn for m, 0 for o, 1 for l ...),
 *         'one_edit' (one letter changed, added, removed, or two swapped), 'scope' (npm scope that imitates a known scope).
 * An exact known name is never reported; PyPI names are compared after PyPI's own normalisation, so Flask_CORS is flask-cors.
 * A name that is not on the list is not reported unless it imitates one. Names shorter than 5 characters are not compared.
 */
function lookAlike(eco, name, index = defaultIndex()) {
  const ix = index[eco];
  if (!ix) return null;
  const n = ix.normalise(name);
  if (ix.all.has(n)) return null;
  if (eco === 'npm' && n.startsWith('@')) {
    const slash = n.indexOf('/');
    if (slash < 0) return null;
    const scope = n.slice(0, slash);
    const rest = n.slice(slash + 1);
    if (ix.scopes.includes(scope)) {
      const under = ix.scoped.filter((k) => k.startsWith(scope + '/')).map((k) => k.slice(slash + 1));
      const hit = imitates(rest, under);
      return hit && { kind: hit.kind, suggestion: scope + '/' + hit.with };
    }
    const hit = imitates(scope.slice(1), ix.scopes.map((s) => s.slice(1)));
    return hit && { kind: 'scope', suggestion: '@' + hit.with + '/' + rest };
  }
  const hit = imitates(n, ix.unscoped);
  return hit && { kind: hit.kind, suggestion: hit.with };
}

/* ------------------------------ settings and messages ------------------------------ */

/* Is the name on the user's allow list (hooks.packageInstallAllow)? */
function allowed(eco, name, allow) {
  if (!allow || !allow.length) return false;
  const n = eco === 'pypi' ? pypiNormalise(name) : name;
  return allow.some((a) => {
    if (a.endsWith('/*')) return eco === 'npm' && n.startsWith(a.slice(0, -1));
    return (eco === 'pypi' ? pypiNormalise(a) : a) === n;
  });
}

const REGISTRY_NAME = { npm: 'the npm registry', pypi: 'PyPI' };
const ECO_NAME = { npm: 'npm package', pypi: 'Python package' };

/* The sentence for one finding. Names come from the command but are cut down to registry-name characters first. */
function sentenceOf(f) {
  const what = ECO_NAME[f.eco] + ' `' + f.name + '`';
  if (f.kind === 'not_found') return what + ' was not found on ' + REGISTRY_NAME[f.eco] + ', so the name may have been made up';
  if (f.kind === 'new_package') return what + ' was first published ' + (f.days < 1 ? 'less than a day' : f.days + ' day' + (f.days === 1 ? '' : 's')) + ' ago';
  if (f.kind === 'scope') return what + ' uses a scope that looks like the well-known one in `' + f.suggestion + '` (did you mean `' + f.suggestion + '`?)';
  return what + ' looks like the well-known `' + f.suggestion + '` (did you mean `' + f.suggestion + '`?)';
}

/** The question for the user, or null when there is nothing to ask. */
function messageOf(findings) {
  if (!findings || !findings.length) return null;
  const list = findings.slice(0, 4).map(sentenceOf);
  return 'zn: this command installs ' + (findings.length === 1 ? 'a package' : 'packages') + ' that needs a second look: ' + list.join('; ') +
    (findings.length > 4 ? '; and ' + (findings.length - 4) + ' more' : '') + '. ' +
    'Names that copy popular packages are used to spread malware, and an agent can make up a name that does not exist. ' +
    'Approve it only if this is the package you want. To stop this question for a name, add it to hooks.packageInstallAllow in ~/.zn/config.json.';
}

/* ------------------------------------- check ------------------------------------- */

/**
 * Checks a command. Returns { findings, unavailable, checked }:
 *   findings     [{ eco, name, kind, suggestion?, days? }]  names that need a question
 *   unavailable  [{ eco, name, why }]                        online lookups that gave no answer (no question is asked)
 *   checked      number of names read from the command
 * opts: { mode: 'offline' | 'online', allow, newDays, index, lookup }
 * `lookup(items)` is the online lookup (package-registry.js); it is only called in online mode, and only with names
 * that the offline step did not already report. In offline mode nothing outside this file is used.
 */
async function check(command, opts = {}) {
  const mode = opts.mode === 'online' ? 'online' : 'offline';
  const allow = opts.allow || [];
  const index = opts.index || defaultIndex();
  const seen = new Set();
  const names = [];
  for (const i of installsOf(command)) {
    const key = i.eco + ':' + i.name;
    if (seen.has(key) || allowed(i.eco, i.name, allow)) continue;
    seen.add(key);
    names.push(i);
  }
  const findings = [];
  const pending = [];
  for (const i of names) {
    const hit = lookAlike(i.eco, i.name, index);
    if (hit) { findings.push({ eco: i.eco, name: i.name, kind: hit.kind, suggestion: hit.suggestion }); continue; }
    // A name on the starter list exists and is old: nothing to ask the registry.
    if (index[i.eco] && index[i.eco].all.has(index[i.eco].normalise(i.name))) continue;
    if (mode === 'online' && !i.registry && !i.legacyCase) pending.push(i);
  }
  const unavailable = [];
  if (mode === 'online' && pending.length && typeof opts.lookup === 'function') {
    const days = newDaysOf(opts.newDays);
    const results = await opts.lookup(pending.map((i) => ({ eco: i.eco, name: i.name })));
    for (const i of pending) {
      const r = results.get(i.eco + ':' + i.name);
      if (!r) continue;
      if (r.error) { unavailable.push({ eco: i.eco, name: i.name, why: r.error }); continue; }
      if (r.state === 'missing') { findings.push({ eco: i.eco, name: i.name, kind: 'not_found' }); continue; }
      if (r.state === 'found' && typeof r.ageDays === 'number' && r.ageDays < days) {
        findings.push({ eco: i.eco, name: i.name, kind: 'new_package', days: Math.floor(r.ageDays) });
      }
    }
  }
  return { findings, unavailable, checked: names.length };
}

module.exports = { check, installsOf, lookAlike, indexOf, messageOf, sentenceOf, allowed, pypiNormalise, oneEdit, skeleton, NAMES };
