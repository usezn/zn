'use strict';

// A .env read written so that the shell or cmd.exe, not the text, spells the name: cmd.exe caret escapes, expansions that leave
// nothing, and the trailing dots and spaces Windows drops. Each is refused when the file is read, and the ordinary uses of the
// same characters stay allowed. Values are fake. The platform is restored after each simulated block.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

function asPlatform(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function project() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hidden-env-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env'), 'API_TOKEN=fake-value-not-a-secret-0001\n');
  fs.writeFileSync(path.join(proj, '.env.local'), 'API_TOKEN=fake-value-not-a-secret-0002\n');
  fs.writeFileSync(path.join(proj, 'notes.md'), 'nothing here\n');
  return { home, proj, opts: { home, cwd: proj, env: { HOME: home, PATH: '/usr/bin:/bin', SHORT: 'ab', BLANK: '' } } };
}

const DENIED = /holds plain-text|was not read because/;

test('cmd.exe caret escapes: every spelling of .env is refused on Windows', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['type .e^nv', 'type ^.env', 'type .^env', 'type .env^', 'type .en^v', 'type ".e^nv"', 'type .^e^n^v',
      'type .env.l^ocal', 'cmd /c type .e^nv', 'copy .e^nv x.txt', 'type < .e^nv']) {
      assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
    }
  });
});

test('cmd.exe caret escapes: refused on any system once cmd or a batch file is named', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['cmd /c type .e^nv', 'cmd.exe /c "type .en^v"', 'CMD /C type .^env', 'run.bat type .e^nv']) {
      assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
    }
  });
});

test('a caret at the end of a line joins the next line (cmd.exe)', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    assert.match(policy.bashDenial('type .e^\nnv', opts) || '', DENIED);
    assert.match(policy.bashDenial('type .e^\r\nnv', opts) || '', DENIED);
  });
});

test('a caret in a POSIX shell is an ordinary character: nothing new is refused', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['grep ^foo notes.md', 'grep ^.env notes.md', 'cat notes.md', 'echo a^b', 'type .e^nv', 'cat .e^nv']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
  });
});

test('carets that do not hide a protected name stay allowed on Windows', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['type no^tes.md', 'echo 1 ^& 2', 'type ^"notes.md^"']) assert.equal(policy.bashDenial(c, opts), null, c);
  });
});

test('expansions that leave nothing: an unset variable, an empty slice, an empty default', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      for (const c of ['cat .en${EMPTY}v', 'cat .e${EMPTY:-}nv', 'cat .e${HOME:0:0}nv', 'cat .e${HOME:3:0}nv', 'cat .e${UNSET:0:0}nv',
        'cat .e$@nv', 'cat .e$*nv', 'cat .e${@}nv', 'cat .e${*:0:0}nv', 'cat .e$(true)nv', 'cat .e$(:)nv',
        'cat .e$()nv', 'cat .e`true`nv', 'cat .e``nv', 'cat .e${SHORT:2}nv', 'cat .e${SHORT:9:3}nv', 'cat .e${UNSET-}nv', 'cat .env.l${UNSET}ocal',
        'cat .e${EMPTY}${EMPTY}nv', 'cat .${EMPTY}env', 'cat .e${UNSET:-n}v', 'cat .e${UNSET-n}v', 'cat .e${EMPTY:-n}${EMPTY}v',
        'cat .e${HOME:+n}v', 'cat .e${SHORT:+n}v', 'cat .e${UNSET:+x}nv', 'cat .e${UNSET+x}nv', 'cat .e${UNSET:-n}${UNSET:-v}',
        'cat .e${BLANK:-n}v', 'cat .en${BLANK-x}v', 'cat .e${BLANK:+x}nv', 'cat .en${BLANK}v']) {
        assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ': ' + c);
      }
    });
  }
});

test('expansions inside nested shells, redirects and other commands are read the same way', () => {
  const { opts } = project();
  for (const c of ['bash -c "cat .e\\${EMPTY}nv"', 'sh -c \'cat .e${EMPTY}nv\'', 'cat < .e${EMPTY}nv', 'head -n1 .e${HOME:0:0}nv', 'cp .e${EMPTY}nv x.txt',
    'cat .en${EMPTY}v | head', 'true && cat .e${UNSET:0:0}nv']) {
    assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  }
});

test('expansions that keep their text stay allowed', () => {
  const { opts } = project();
  for (const c of ['cat notes${EMPTY}.md', 'echo ${HOME:0:0}', 'echo ${HOME:0:2}x', 'cat ${PATH:0:0}notes.md', 'echo ${SHORT:1}', 'echo $@', 'echo $(true)',
    'cat notes.md${UNSET:-}', 'echo ${UNSET:-fallback}', 'echo ${SHORT:-1:2}', 'cat ${UNSET:-notes.md}', 'cat .e${HOME:-n}v', 'cat .e${SHORT:-n}v',
    'echo ${UNSET:+x}', 'echo ${SHORT:+x}', 'cat .e${BLANK-n}v']) {
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});

test('a negative offset or length is left as typed, not guessed', () => {
  const { opts } = project();
  assert.equal(policy.bashDenial('echo ${SHORT: -1}', opts), null);
  assert.equal(policy.bashDenial('echo ${SHORT:0:-1}', opts), null);
});

test('trailing dots and spaces on Windows: refused whatever is appended, in any command', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['cat .env.', 'cat .env..', 'cat ".env "', 'cat ".env."', 'cat ".env. ."', 'cat .env.local.', 'type .env.local ', 'type ".env.local "',
      'copy .env.local. x.txt', 'type < .env.local.', 'Get-Content .env.', 'Get-Content ".env "', 'more < .env.', 'cat ./.env.', 'cat proj/../.env.',
      'cat ".env ..  "', 'cat .env.local. .']) {
      assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
    }
  });
});

test('trailing dots and spaces elsewhere stay allowed on Windows, and a dot at the end is a different file on POSIX', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['cat notes.md.', 'cat "notes.md "', 'cat ./notes.md.', 'cat . ..']) assert.equal(policy.bashDenial(c, opts), null, c);
  });
  asPlatform('linux', () => {
    for (const c of ['cat .env.', 'cat ".env "', 'cat .env..']) assert.equal(policy.bashDenial(c, opts), null, c);
  });
});

test('carets and empty expansions together', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['cmd /c type .e^${EMPTY}nv', 'type .e${EMPTY}^nv', 'type .e^n${HOME:0:0}v']) {
      assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
    }
  });
});

test('the plain forms still behave as before', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      assert.match(policy.bashDenial('cat .env', opts) || '', DENIED);
      assert.match(policy.bashDenial('type .env.local', opts) || '', DENIED);
      assert.equal(policy.bashDenial('cat notes.md', opts), null);
      assert.equal(policy.bashDenial('echo hello', opts), null);
    });
  }
});

test('a long run of carets or expansions costs time in proportion to its length', () => {
  const { opts } = project();
  for (const text of ['type ' + '^'.repeat(20000) + '.env', 'cat ' + '${E}'.repeat(5000) + 'notes.md', 'cat .e' + '$()'.repeat(5000) + 'nv']) {
    const t0 = process.hrtime.bigint();
    asPlatform('win32', () => policy.bashDenial(text, opts));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 5000, 'took ' + ms + ' ms');
  }
});
