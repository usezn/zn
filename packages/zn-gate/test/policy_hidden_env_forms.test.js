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
    for (const c of ['type .e^nv', 'type ^.env', 'type .^env', 'type .env^', 'type .en^v', 'type .^e^n^v', 'type .e^"n"v', 'cmd /c "type .e^nv"',
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
    for (const c of ['grep ^foo notes.md', 'grep ^.env notes.md', 'cat notes.md', 'echo a^b', 'type .e^nv', 'cat .e^nv', 'grep ^.env cmd/notes.md', 'ls cmd/ && grep ^.env README.md',
      'go build ./cmd/app && grep ^x notes.md']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
  });
});

test('carets that do not hide a protected name stay allowed on Windows', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['type no^tes.md', 'echo 1 ^& 2', 'type ^"notes.md^"', 'type ".e^nv"', 'findstr /r "^.env" notes.md', 'findstr "^x" notes.md']) assert.equal(policy.bashDenial(c, opts), null, c);
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
        'cat .e${HOME:+n}v', 'cat .e${SHORT:+n}v', 'cat .e${UNSET:+x}nv', 'cat .e${UNSET+x}nv', 'cat .e${UNSET:-n}${UNSET:-v}', 'cat .e${HOME:-n}v', 'cat .e${SHORT:-n}v', 'cat .e${BLANK-n}v',
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
    'cat notes.md${UNSET:-}', 'echo ${UNSET:-fallback}', 'echo ${SHORT:-1:2}', 'cat ${UNSET:-notes.md}',
    'echo ${UNSET:+x}', 'echo ${SHORT:+x}']) {
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

test('cmd substring and replacement modifiers inside a name: refused on Windows and wherever cmd is named', () => {
  const { opts } = project();
  const env = { ...opts.env, OS: 'Windows_NT', SHORT: 'ab' };
  const o = { ...opts, env };
  asPlatform('win32', () => {
    for (const c of ['type .e%OS:~0,0%nv', 'type .en%UNSET:~0,0%v', 'type .e%os:~0,0%nv', 'type .en%OS:~99%v', 'type .e%SHORT:ab=%nv', 'type .e%SHORT:ab=n%v',
      'cmd /v:on /c type .e!OS:~0,0!nv', 'cmd /v:on /c type .e!SHORT:ab=!nv', 'type .env.l%OS:~0,0%ocal', 'type .e%OS:~0,0%%OS:~0,0%nv']) {
      assert.match(policy.bashDenial(c, o) || '', DENIED, c);
    }
    for (const c of ['type notes%OS:~0,0%.md', 'type %OS:~0,3%', 'echo %SHORT:ab=cd%', 'type no%OS:~0,0%tes.md']) assert.equal(policy.bashDenial(c, o), null, c);
  });
  asPlatform('linux', () => {
    for (const c of ['cmd /c type .e%OS:~0,0%nv', 'cmd.exe /c "type .en%UNSET:~0,0%v"']) assert.match(policy.bashDenial(c, o) || '', DENIED, c);
    // Not cmd: the text is an ordinary word in a POSIX shell.
    assert.equal(policy.bashDenial('echo .e%OS:~0,0%nv', o), null);
  });
});

test('more spellings of an expansion that leaves nothing or a fixed word (every one reads .env in bash)', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      for (const c of ['cat .e$UNSET""nv', "cat .e$UNSET''nv", 'cat .e$UNSET\\nv', 'cat .e$1nv', 'cat .e${1}nv', 'cat .e${HOME::0}nv', 'cat .e${HOME: -0:0}nv',
        'cat .e${HOME:(0):0}nv', 'cat .e${HOME/*/}nv', 'cat .e${HOME%%*}nv', 'cat .e${HOME##*}nv', 'cat .en$(echo)v', 'cat .en$(printf "")v', 'cat .e${UNSET:-"n"}v',
        'cat .e${UNSET:=n}v', 'cat .e${UNSET:-${UNSET2}}nv', 'cat .e${UNSET:-${UNSET2:-n}}v', 'cat .e$#nv', 'cat .e$?nv'.replace('$?', '$@'), 'cat .e$((0))nv'.replace('$((0))', '$(())'),
        'cat .e`echo`nv', 'cat .e${UNSET:-\'n\'}v', 'cat .e$UNSET${UNSET2}nv', 'cat .en${UNSET:-zzz}v', 'cat .e${HOME:-zzz}nv', 'cat .e${UNSET:+zzz}nv', 'cat .e${PATH}${UNSET}nv'.replace('${PATH}', '${UNSET3}')]) {
        assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ': ' + c);
      }
    });
  }
});

test('an unbalanced unit leaves the rest of the text as it was and never throws', () => {
  const { opts } = project();
  for (const c of ['cat ${UNSET', 'cat $(echo', 'cat `echo', 'echo ${', 'echo $', 'echo $((1', 'cat notes.md ${']) {
    assert.doesNotThrow(() => policy.bashDenial(c, opts), c);
  }
});

test('cmd %VAR% units: refused on Windows and wherever cmd is named, undefined or empty variables and negative offsets included', () => {
  const { opts } = project();
  const o = { ...opts, env: { ...opts.env, OS: 'Windows_NT', BLANK: '' } };
  asPlatform('win32', () => {
    for (const c of ['type .e%OS:~0,0%nv', 'type .e%OS:~10,0%nv', 'type .e%OS:~-1,0%nv', 'type .e%BLANK%nv', 'type .e%NOPE%nv', 'cmd /v:on /c type .e!OS:~0,0!nv',
      'type .e%NOPE%^nv'.replace('^', ''), 'type .e%NOPE%%NOPE2%nv', 'type %NOPE%.env', 'type .%NOPE:x=y%env', 'type .e^n%NOPE%v', 'type .e%NOPE%^n^v'.replace('%^n^v', '%nv')]) {
      assert.match(policy.bashDenial(c, o) || '', DENIED, c);
    }
    for (const c of ['type notes%NOPE%.md', 'echo %OS%', 'type no%NOPE%tes.md']) assert.equal(policy.bashDenial(c, o), null, c);
  });
  asPlatform('linux', () => {
    for (const c of ['cmd /c type .e%NOPE%nv', 'run.bat type .e%NOPE%nv']) assert.match(policy.bashDenial(c, o) || '', DENIED, c);
    assert.equal(policy.bashDenial('echo .e%NOPE%nv', o), null);
  });
});

test('cmd is cmd.exe only in command position: a folder named cmd is not', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['grep ^.env cmd/notes.md', 'cat cmd/main.go ^x', 'cd cmd && grep ^.env notes.md', 'go run ./cmd/zn ^.env']) assert.equal(policy.bashDenial(c, opts), null, c);
    for (const c of ['cmd /c type .e^nv', 'ls && cmd.exe /c type .e^nv', '(cmd /c type .e^nv)', 'C:\\Windows\\System32\\cmd.exe /c type .e^nv']) assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  });
});

test('an expansion that comes out empty is refused whatever the environment the hook sees holds', () => {
  const { opts } = project();
  // The hook sees no X, an X that empties the slice, and an X that does not: the result is the same.
  for (const extra of [{}, { X: 'x' }, { X: 'n' }]) {
    const o = { ...opts, env: { ...opts.env, OS: 'Windows_NT', ...extra } };
    asPlatform('linux', () => {
      assert.match(policy.bashDenial('cat .e${X:0:0}nv', o) || '', DENIED, 'linux ' + JSON.stringify(extra));
    });
    asPlatform('win32', () => {
      assert.match(policy.bashDenial('type .e%X:~0,1%nv', o) || '', DENIED, 'win32 ' + JSON.stringify(extra));
    });
  }
});

test('an expansion is read as any text: a name that a variable or substitution could complete is refused whatever the environment holds', () => {
  const { opts } = project();
  const attacks = ['cat .e$(echo n)v', 'cat .e`echo n`v', 'read X <<< n; cat .e${X}v', 'cat .e${X}v', 'cat ${D}env', 'cat ${D}.env', 'cat .e${X}',
    'cat .env${S}', 'cat .e$1v', 'cat .e"$X"v', 'cat "$HOME"/.e${X}v', 'cat sub/.e${X}v', 'cat .e$(echo n)v.local', 'cat .e$(printf n)v',
    'cat $(printf .en)v', 'cat $(echo .en)v', 'bash -c "cat .e\${X}v"', 'cat ${D}env.local', 'cat ~/.ssh/id_${K}', 'cat ${A}d_rsa'];
  for (const extra of [{}, { X: 'n', D: '.', K: 'rsa' }, { X: 'q' }]) {
    const o = { ...opts, env: { ...opts.env, ...extra } };
    asPlatform('linux', () => {
      for (const c of attacks) assert.match(policy.bashDenial(c, o) || '', /holds plain-text|was not read because/, c + ' ' + JSON.stringify(extra));
    });
  }
});

test('an expansion read as any text: cmd.exe variable units spell a name the same way', () => {
  const { opts } = project();
  asPlatform('win32', () => {
    for (const c of ['type .e%X:~0,1%v', 'type .e!X!v', 'type .e%X%v', 'cmd /c type .e%X%v', 'set X=n& type .e%Y%v']) {
      assert.match(policy.bashDenial(c, opts) || '', /holds plain-text|was not read because/, c);
    }
    for (const c of ['echo %USERPROFILE%', 'type %USERPROFILE%/notes.md', 'type %CD%/x.txt']) assert.equal(policy.bashDenial(c, opts), null, c);
  });
});

test('an expansion read as any text: ordinary uses stay allowed', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['echo $HOME', 'cat $HOME/notes.md', 'cat ${DIR}/notes.md', 'cat ${NAME}.txt', 'source ${VENV}/bin/activate',
      'cat ${ROOT}/.venv/bin/python', 'cat $1', 'echo v${VERSION}', 'cat ${X}v', 'cp dist/${NAME}-${VERSION}.tgz x', 'cat ${CI_ENV}',
      'cat config/${ENV}.json', 'cat .github/${WF}.yml', 'cat src/${MOD}/env.ts', 'cat ${APP}.env.example', 'cat ${APP}.env.sample',
      'echo $(date)v', 'cat $(pwd)/notes.md', 'ls $(git rev-parse --show-toplevel)/src', 'echo "$X" > .e${Y}v']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
  });
});

test('an unquoted expansion splits into words: each piece is checked, and the safe ending only ends a real word', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['cat a${IFS}.env', 'cat a$IFS.env', 'cat foo${X}.env', 'cat a$(printf " ").env',
      'cat .e$(printf "nv ")v.example', 'cat .e${X}v.example', 'cat .e${X}v.sample', 'cat .e${X}v.template', 'cat .e$X.example',
      'cat x${IFS}id_rsa', 'cat ~/.ssh/a${IFS}id_ed25519', 'cat a${IFS}.env.local', 'cat "a"${IFS}.env']) {
      assert.match(policy.bashDenial(c, opts) || '', /was not read because/, c);
    }
    // Inside double quotes the value is one word: no split, so the same lines read like any other quoted name.
    for (const c of ['cat .e"$X"v.example', 'cat "a${IFS}.env"', 'cat "foo${X}.env"', 'cat "a$IFS.env"']) assert.equal(policy.bashDenial(c, opts), null, c);
    assert.match(policy.bashDenial('cat ".e${X}v"', opts) || '', /was not read because/);
    for (const c of ['cat ${HOME}/notes.md', 'cat $HOME/notes.md', 'cat config/${ENV}.json', 'cat ${APP}.env.example', 'cat "${APP}".env.example',
      'cat ${APP}.env.sample', 'cat src/${MOD}/env.ts', 'cat ${PREFIX}/etc/environment', 'cat ${X}.envrc.txt', 'cd ${PROJECT}/environments',
      'echo v${VERSION}', 'tar czf dist/${NAME}-${VERSION}.tgz .', 'cat a${IFS}b.txt', 'cat ${A}${B}notes', 'cat "${APP}.env.example"',
      'cat $(pwd)/.env.example']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
  });
});

test('known limit: a segment that keeps two letters of the name is refused even when it names something else', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    // Accepted false positive: ${PREFIX}env could be .env, so it is refused. Write the name out to read it.
    // Same for a key name cut by an unquoted expansion: id_${T}.pub could split into id_rsa and .pub.
    assert.match(policy.bashDenial('cat ~/.ssh/id_${T}.pub', opts) || '', /was not read because/);
    assert.match(policy.bashDenial('ls ${PREFIX}env', opts) || '', /was not read because/);
  });
});

test('known limit: a name wholly inside a variable or a substitution is not read', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    // Documented in the threat model: the hook cannot see a value that no text holds. A variable assigned in the same line is followed.
    assert.equal(policy.bashDenial('cat $NAME', opts), null);
    assert.equal(policy.bashDenial('cat $(cat names.txt)', opts), null);
    assert.match(policy.bashDenial('NAME=.env; cat $NAME', opts) || '', /holds plain-text|was not read because/);
  });
});
