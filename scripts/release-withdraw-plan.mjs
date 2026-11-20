#!/usr/bin/env node
// Withdrawal plan for a bad release of zn-gate. It prints the commands a maintainer runs, and it checks the
// state from JSON that the caller read with read-only commands. It never publishes, deprecates, yanks or edits
// a release: it reads the files it is given and prints text.
//
//   node scripts/release-withdraw-plan.mjs print <bad> <good> [<dist-tags.json>]
//     Prints the steps and the exact commands. With <dist-tags.json> (`npm view zn-gate dist-tags --json`),
//     the npm dist-tag commands are only for the tags that point to <bad>. Without it, they are printed for
//     latest, next and release-X.Y of <bad>, to be used only where the tag points to <bad>.
//
//   node scripts/release-withdraw-plan.mjs check <bad> <good> <dist-tags.json> [<view.json>] [<versions.json>]
//     Read-only state check. <view.json> is `npm view zn-gate@<bad> --json`, <versions.json> is
//     `npm view zn-gate versions --json`. Prints one line per result: OK, PENDING (a step is still to do)
//     or FAIL (the plan must not go ahead). Exit 0 when there is no FAIL, 1 otherwise.
//
// Versions are compared with the rules of npm-dist-tag-plan.mjs.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compare, parse } from '../.github/scripts/npm-dist-tag-plan.mjs';

export const PACKAGE = 'zn-gate';
export const GITHUB_REPO = 'usezn/zn';

function requireVersion(v, label) {
  const p = parse(v);
  if (!p) throw new Error(`${label} is not a valid semver version: ${JSON.stringify(v)}`);
  return p;
}

// The PyPI form of a version: 1.17.0-rc.1 -> 1.17.0rc1 (PEP 440). Final versions are unchanged.
export function pypiVersion(v) {
  const p = requireVersion(v, 'version');
  if (!p.pre.length) return v;
  const kind = { alpha: 'a', beta: 'b', rc: 'rc' }[p.pre[0]];
  if (!kind || p.pre.length !== 2 || !/^\d+$/.test(p.pre[1])) throw new Error(`no PyPI form for ${v}`);
  return `${p.major}.${p.minor}.${p.patch}${kind}${p.pre[1]}`;
}

export function printPlan(bad, good, tags = null) {
  const b = requireVersion(bad, 'bad');
  requireVersion(good, 'good');
  if (bad === good) throw new Error('bad and good are the same version');
  const out = [];
  const say = (s = '') => out.push(s);

  say(`Withdrawal plan for ${PACKAGE}: ${bad} -> ${good}`);
  say('This text is printed only. Nothing here is run; each command is run by a maintainer after the GO.');
  say('');

  say('1. npm dist-tags (run first, so installs move to the good version)');
  let tagNames;
  if (tags !== null) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) throw new Error('dist-tags is not an object');
    tagNames = Object.keys(tags).filter((t) => tags[t] === bad);
  } else {
    tagNames = ['latest', 'next', `release-${b.major}.${b.minor}`];
  }
  if (tagNames.length === 0) {
    say('   no dist-tag points to the bad version: nothing to move');
  }
  for (const t of tagNames) say(`   npm dist-tag add ${PACKAGE}@${good} ${t}`);
  if (tags === null) say('   (only where the tag points to the bad version: npm view zn-gate dist-tags --json)');
  say('');

  say('2. npm deprecate (a warning on the bad version; it does not remove the package)');
  say(`   npm deprecate ${PACKAGE}@${bad} "Withdrawn: use ${good} instead."`);
  say('');

  say('3. GitHub release (hidden as a draft; reversible with --draft=false)');
  say(`   gh release edit v${bad} --draft=true -R ${GITHUB_REPO}`);
  say(`   gh release edit v${good} --latest -R ${GITHUB_REPO}`);
  say('');

  say('4. PyPI (no command in this plan: yank the release on the project page, with the reason)');
  say(`   yank ${PACKAGE} ${pypiVersion(bad)} on pypi.org`);
  say('');

  say('5. MCP Registry (check by hand: the status of the bad version is set with the registry tooling)');
  say(`   io.github.usezn/zn-gate version ${bad}: mark as withdrawn; version ${good} stays the latest`);
  say('');

  say('6. Text (the same message everywhere)');
  say(`   CHANGELOG.md: a withdrawn note for ${bad}, pointing to ${good}`);
  say('   Security advisory, if the release had one: list it in SECURITY.md as the advisory requires');
  say('');

  say(`Then run: node .github/scripts/release-withdraw-plan.mjs check ${bad} ${good} <dist-tags.json> <view.json> <versions.json>`);
  return out.join('\n');
}

export function checkWithdrawal({ bad, good, tags, view = null, versions = null }) {
  const out = [];
  const add = (level, text) => out.push({ level, text });

  if (!parse(bad)) { add('FAIL', `bad version is not valid semver: ${JSON.stringify(bad)}`); return out; }
  if (!parse(good)) { add('FAIL', `good version is not valid semver: ${JSON.stringify(good)}`); return out; }
  if (bad === good) { add('FAIL', 'good and bad are the same version'); return out; }
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) { add('FAIL', 'dist-tags is not an object'); return out; }

  let list = versions;
  if (typeof list === 'string') list = [list];
  if (list !== null) {
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
      add('FAIL', 'versions is not a list of versions');
      return out;
    }
    if (list.includes(good)) add('OK', `good ${good} is published`);
    else add('FAIL', `good ${good} is not published on npm`);
  }

  const pointing = Object.keys(tags).filter((t) => tags[t] === bad);
  if (pointing.length === 0) add('OK', `no dist-tag points to ${bad}`);
  for (const t of pointing) add('PENDING', `dist-tag ${t} still points to ${bad}`);
  if (tags.latest === bad && parse(good).pre.length) add('FAIL', `latest would point to the prerelease ${good}`);

  if (view !== null) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
      add('FAIL', 'view is not an object');
    } else if (view.version !== undefined && view.version !== bad) {
      add('FAIL', `view is for ${view.version}, not ${bad}`);
    } else if (typeof view.deprecated === 'string' && view.deprecated.includes(good)) {
      add('OK', `${bad} is deprecated and names ${good}`);
    } else if (typeof view.deprecated === 'string' && view.deprecated.length > 0) {
      add('PENDING', `${bad} is deprecated, but the message does not name ${good}`);
    } else {
      add('PENDING', `${bad} is not deprecated yet`);
    }
  } else {
    add('PENDING', `no view given: the deprecation of ${bad} is not checked`);
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(argv) {
  const [cmd, ...a] = argv;
  try {
    if (cmd === 'print' && (a.length === 2 || a.length === 3)) {
      console.log(printPlan(a[0], a[1], a[2] ? readJson(a[2]) : null));
      return 0;
    }
    if (cmd === 'check' && a.length >= 3 && a.length <= 5) {
      const results = checkWithdrawal({
        bad: a[0],
        good: a[1],
        tags: readJson(a[2]),
        view: a[3] ? readJson(a[3]) : null,
        versions: a[4] ? readJson(a[4]) : null,
      });
      for (const r of results) console.log(`${r.level} ${r.text}`);
      return results.some((r) => r.level === 'FAIL') ? 1 : 0;
    }
    throw new Error('usage: release-withdraw-plan.mjs print <bad> <good> [<dist-tags.json>] | check <bad> <good> <dist-tags.json> [<view.json>] [<versions.json>]');
  } catch (e) {
    console.error(`::error::${e.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
