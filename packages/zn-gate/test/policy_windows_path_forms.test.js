'use strict';

process.env.ZN_STATS = 'off';

// The protected-path checks of the file hook against the ways Windows lets one file be named: mixed and repeated
// separators, "." and ".." segments, the \\?\ and \\.\ prefixes, a share name, NTFS alternate data streams, trailing dots
// and spaces, and 8.3 short names. Each target is read, written (agent configuration, zn's own folder) or deleted as the
// tool call would name it. The forms that are protected today are pinned; the forms that are not are listed as todo, so
// a fix shows up as a todo that passes.
//
// The path module is the Windows one, as on a Windows host, so the same results come out on any system. Only fake
// names under C:\Users\alice are used, and nothing is read from or written to disk.
//
// Not listed on purpose: \\?\C:/Users/... (the \\?\ prefix turns the slash off, so Windows does not open that name)
// and a trailing dot or space after the \\?\ prefix (it keeps them, so that is another file).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const WIN_PATH = require('node:path').win32;
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'path' || request === 'node:path') return WIN_PATH;
  return realLoad.call(this, request, ...rest);
};
let policy;
try {
  policy = require('../lib/hooks/policy');
} finally {
  Module._load = realLoad;
}

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const B = String.fromCharCode(92);
const HOME = 'C:' + B + 'Users' + B + 'alice';
const O = { cwd: HOME + B + 'proj', home: HOME, env: {} };

// 8.3 short name of a long name: up to six characters, "~1", and the first three of the extension (a leading dot is dropped).
function short(name) {
  const m = /^(\.?)([^.]+)(\.[^.]*)?$/.exec(name);
  if (!m) return name;
  return m[2].slice(0, 6).toUpperCase() + '~1' + (m[3] ? m[3].slice(0, 4).toUpperCase() : '');
}

/** [name, text] for every spelling of the same path (relative to the home folder, written with "/"). */
function spellings(rel) {
  const segs = rel.split('/');
  const last = segs[segs.length - 1];
  const dir = segs.slice(0, -1);
  const dirText = (sep, f) => dir.map(f || ((d) => d)).join(sep) + (dir.length ? sep : '');
  const win = rel.split('/').join(B);
  const lead = (prefix) => prefix + HOME + B;
  return [
    ['backslashes', HOME + B + win],
    ['forward slashes', 'C:/Users/alice/' + rel],
    ['mixed slashes', 'C:' + B + 'Users/alice' + B + dirText('/') + last],
    ['mixed slashes, other way', 'C:/Users' + B + 'alice/' + dirText(B) + last],
    ['doubled separators', HOME + B + B + dirText(B + B) + last],
    ['dot segment', HOME + B + '.' + B + win],
    ['dot-dot segment', HOME + B + 'proj' + B + '..' + B + win],
    ['long prefix', lead(B + B + '?' + B) + win],
    ['device prefix', lead(B + B + '.' + B) + win],
    ['long UNC prefix to the admin share', B + B + '?' + B + 'UNC' + B + 'localhost' + B + 'C$' + B + 'Users' + B + 'alice' + B + win],
    ['admin share', B + B + 'localhost' + B + 'C$' + B + 'Users' + B + 'alice' + B + win],
    ['stream ::$DATA', HOME + B + win + '::$DATA'],
    ['named stream', HOME + B + win + ':x'],
    ['stream then trailing dot', HOME + B + win + '::$DATA.'],
    ['trailing dot', HOME + B + win + '.'],
    ['trailing space', HOME + B + win + ' '],
    ['trailing dot on the folder', HOME + B + dirText(B, (d) => d + '.') + last],
    ['trailing dot then stream', HOME + B + win + '.::$DATA'],
    ['long prefix and stream', lead(B + B + '?' + B) + win + '::$DATA'],
    ['short last name', HOME + B + dirText(B) + short(last)],
    ['short folder names', HOME + B + dirText(B, short) + last],
    ['short folder and last names', HOME + B + dirText(B, short) + short(last)],
    ['short home folder', 'C:' + B + 'Users' + B + 'ALICE~1' + B + win],
    ['short last name and trailing dot', HOME + B + dirText(B) + short(last) + '.'],
    ['short last name and stream', HOME + B + dirText(B) + short(last) + '::$DATA'],
    ['short last name, other number', HOME + B + dirText(B) + short(last).replace('~1', '~2')],
    ['long prefix and short last name', lead(B + B + '?' + B) + dirText(B) + short(last)],
  ];
}

const CREDENTIAL = (p) => [
  policy.readDenial(p, O),
  policy.bashDenial('cat "' + p + '"', O),
  policy.bashDenial('type "' + p + '"', O),
  policy.bashDenial('Remove-Item "' + p + '"', O),
  policy.bashDenial('del "' + p + '"', O),
];
const AGENT_CONFIG = (p) => [
  policy.writeDenial(p, O),
  policy.bashDenial('echo x > "' + p + '"', O),
  policy.bashDenial('Remove-Item "' + p + '"', O),
  policy.bashDenial('del "' + p + '"', O),
];
const ZN_STATE = (p) => [...CREDENTIAL(p), ...AGENT_CONFIG(p)];
const DOTENV = (p) => [policy.classifyPath(p, O)];

// target: [relative path from the home folder, what the checks must refuse, the forms that are not refused yet]
const PREFIXES = ['long prefix', 'device prefix', 'long UNC prefix to the admin share', 'admin share', 'long prefix and stream',
  'long prefix and short last name'];
const SHORT_FOLDERS = ['short folder names', 'short folder and last names', 'short home folder', 'long prefix and short last name'];
const TARGETS = {
  'aws credentials': ['.aws/credentials', CREDENTIAL, ['long prefix and short last name']],
  'ssh private key': ['.ssh/id_rsa', CREDENTIAL, []],
  'claude settings': ['.claude/settings.json', AGENT_CONFIG, ['long prefix and short last name']],
  'codex config': ['.codex/config.toml', AGENT_CONFIG, ['short folder names', 'short folder and last names']],
  'package registry token': ['.npmrc', CREDENTIAL, PREFIXES],
  'zn vault': ['.zn/vault.json', ZN_STATE, [...PREFIXES, ...SHORT_FOLDERS]],
  'zn audit log': ['.zn/evidence.jsonl', ZN_STATE, [...PREFIXES, ...SHORT_FOLDERS, 'short home folder']],
  'agent plugin folder': ['.claude/plugins/p/hook.js', AGENT_CONFIG, [...PREFIXES, ...SHORT_FOLDERS]],
  'project .env': ['proj/.env', DOTENV, []],
};

function misses(check, rel, skip) {
  return asWindows(() => {
    const out = [];
    for (const [name, text] of spellings(rel)) {
      if (skip.includes(name)) continue;
      const results = check(text);
      if (results.some((r) => !r)) out.push(name + ' -> ' + results.map((r) => (r ? 'refused' : 'allowed')).join(','));
    }
    return out;
  });
}

for (const [label, [rel, check, gaps]] of Object.entries(TARGETS)) {
  test(label + ': every Windows spelling that is checked today is refused', () => {
    assert.deepEqual(misses(check, rel, gaps), []);
  });
  if (gaps.length) {
    // Spellings that name the same file but are not refused yet. The names are listed, so a fix turns the todo green.
    test(label + ': spellings that are not refused yet', { todo: 'not refused yet' }, () => {
      const names = gaps.filter((g, i) => gaps.indexOf(g) === i);
      const all = asWindows(() => spellings(rel).filter(([n]) => names.includes(n)).map(([n, t]) => [n, check(t)]));
      assert.deepEqual(all.filter(([, r]) => r.some((x) => !x)).map(([n]) => n), []);
    });
  }
}

test('files that are not protected stay open under the same spellings', () => {
  asWindows(() => {
    for (const rel of ['.ssh/id_rsa.pub', 'proj/README.md', 'proj/.env.example', 'proj/src/app.js']) {
      for (const [name, text] of spellings(rel)) {
        if (/short/.test(name)) continue; // a short name stands for a file that may be protected
        const c = policy.classifyPath(text, O);
        assert.equal(c, null, rel + ' as ' + name + ': ' + JSON.stringify(c));
        assert.equal(policy.readDenial(text, O), null, rel + ' as ' + name);
        assert.equal(policy.writeDenial(text, O), null, rel + ' as ' + name);
      }
    }
  });
});

test('agent configuration can be read under every spelling (only changing it is refused)', () => {
  asWindows(() => {
    for (const [name, text] of spellings('.claude/settings.json')) {
      assert.equal(policy.readDenial(text, O), null, name);
    }
  });
});

test('a short name with another number stands for the same long name', () => {
  asWindows(() => {
    assert.ok(policy.classifyPath(HOME + B + '.aws' + B + 'CREDEN~2', O));
    assert.ok(policy.classifyPath(HOME + B + 'AWS~3' + B + 'credentials', O));
  });
});
