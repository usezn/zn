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
const { budget } = require('./helpers/time_budget');

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

const DENIED = /holds plain-text|was not read because|builds the path of a .env file/;

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
    assert.equal(policy.bashDenial('cat .e"$X"v.example', opts), null);
    // A variable right before the .env name is refused even inside double quotes, whatever literal text comes before it (its value could be a folder
    // separator): an accepted false positive of the name rule, not of the split reading.
    for (const c of ['cat "a${IFS}.env"', 'cat "foo${X}.env"', 'cat "a$IFS.env"']) assert.match(policy.bashDenial(c, opts) || '', /builds the path of a \.env file/, c);
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

test('a piece an unquoted expansion cuts off is also read as a glob, as the shell globs each word after splitting', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['cat a${IFS}.e*', 'cat a${IFS}.en?', 'cat a${IFS}.en[v]', 'cat a${IFS}?env', 'cat a${IFS}.e?v', 'cat a${IFS}.??v',
      'cat a${IFS}.[e]nv', 'cat a${X}.e*', 'cat a${X}.en?', 'cat a${X}.en[v]', 'cat a${X}?env', 'cat a$IFS.e*', 'cat a${IFS}.e*${Y}',
      'cat a${IFS}.e*.example${IFS}x', 'cat ~/.ssh/a${IFS}id_*', 'cat a${IFS}id_r?a', 'cat a${IFS}id_[r]sa', 'cat a${IFS}.env*']) {
      assert.match(policy.bashDenial(c, opts) || '', /was not read because|\.env|credential|SSH|private key|protected/i, c);
    }
    // One word, no split: a quoted expansion keeps its glob with the rest of the word, which starts with other text.
    for (const c of ['cat "a${IFS}".en?', 'cat a"${IFS}".e*', 'cat "a${IFS}".e*', 'cat ${DIR}/*.md', 'cat a${IFS}*.md', 'cat a${IFS}*',
      'cat a${IFS}n?tes.md', 'cat a${IFS}[a-c]*.txt', 'cat a${IFS}.e*.example', 'cat ${DIR}/*.json']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
    // Names that start with id_ or end with a key type next to an unquoted expansion are refused on purpose.
    for (const c of ['cat id_${T}.txt', 'cp ${SRC}/id_${T}.pub ${DST}/']) assert.match(policy.bashDenial(c, opts) || '', /was not read because/, c);
  });
});

test('ordinary lines with unquoted expansions stay allowed', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['echo $HOME', 'cd $HOME/projects', 'source ${VENV}/bin/activate', 'docker run -e APP_ENV=${ENV} img', 'cat config/${ENV}.json',
      'cat ${APP}.env.example', 'cat src/${MOD}/env.ts', 'tar czf dist/${NAME}-${VERSION}.tgz .', 'uv run --env-file ${ENVFILE} x',
      'docker compose --env-file ${ENV_FILE} up', 'pytest tests/${TEST}_env.py', 'cat ~/.ssh/id_rsa.pub', 'cat ${DIR}/environment.yml',
      'ls ${DIR}/*.py', 'rm ${TMPD}/*.log', 'grep -r foo ${SRC}/lib/*.js', 'cat ${A}/*.md ${B}/?.txt', 'cat ${DIR}/[a-c]*.txt']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
  });
});

// --- review of #849, second round: quoted brackets, any cmd variable name, an unpaired ! under delayed expansion ---

test('a quoted closing bracket does not end an expansion unit early', () => {
  const { opts } = project();
  for (const c of ['cat .en$(: ")")v', 'cat .en$(echo ")" >/dev/null)v', 'cat .e${U:+"}"}nv', 'cat .e${U:+")"}nv', 'cat .en$(: "(")v', "cat .e${U:+'}'}nv",
    'cat .e${U:+\\}}nv', 'cat .en$(: \\))v', 'cat .e${U:+"$(echo })"}nv', 'cat .en$(echo $(echo ")"))v', 'cat .e${U:-"a b"}nv'.replace('a b', '')]) {
    for (const plat of ['linux', 'win32']) asPlatform(plat, () => assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c));
  }
  // deep nesting costs a bounded amount and never throws; an unbalanced quote leaves the text as it was
  const deep = 'cat .e' + '$('.repeat(30000) + ':' + ')'.repeat(30000) + 'nv';
  assert.doesNotThrow(() => policy.bashDenial(deep, opts));
  assert.doesNotThrow(() => policy.bashDenial('cat .e$(: "nv', opts));
  assert.equal(policy.bashDenial('cat notes.txt$(: ")")', opts), null);
  assert.equal(policy.bashDenial('echo "a)" $(echo ")") b', opts), null);
});

test('cmd variable names are not only identifiers', () => {
  const { opts } = project();
  const o = { ...opts, env: { ...opts.env, 'ProgramFiles(x86)': 'C:\\PF' } };
  asPlatform('win32', () => {
    for (const c of ['type .e%ProgramFiles(x86):~0,0%nv', 'type .e%CommonProgramFiles(x86):~0,0%nv', 'type .e%=ExitCode:~0,0%nv', 'type .e%A.B%nv', 'type .e%A-B%nv',
      'type .e%A B%nv', 'type .e!ProgramFiles(x86):~0,0!nv', 'cmd /v:on /c type .e!A.B!nv', 'type .e%ProgramFiles(x86):x=y%nv']) {
      assert.match(policy.bashDenial(c, o) || '', DENIED, c);
    }
    for (const c of ['type notes.txt', 'echo 100% done', 'echo 50% of 60%', 'type notes%ProgramFiles(x86):~0,0%.txt']) assert.equal(policy.bashDenial(c, o), null, c);
  });
  asPlatform('linux', () => {
    assert.match(policy.bashDenial('cmd /c type .e%ProgramFiles(x86):~0,0%nv', o) || '', DENIED);
    assert.equal(policy.bashDenial('echo .e%ProgramFiles(x86):~0,0%nv', o), null);
  });
});

test('cmd with delayed expansion removes an ! that has no partner', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      for (const c of ['cmd /v:on /c type .e!nv', 'cmd /v:on /c type .env!', 'cmd /v:on /c type .env!::$DATA', 'cmd /v:on /c type .e!A.B!nv', 'cmd /v:on /c type .env!x!::$DATA',
        'cmd /v:on /c type ".env!::$DATA"', 'cmd /v:on /c type .e!n!v', 'cmd /v /c type .e!nv', 'cmd /c "setlocal enabledelayedexpansion & type .e!nv"', 'cmd /v:on /c type .env^!::$DATA']) {
        assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c);
      }
      // without delayed expansion an unpaired ! is an ordinary character; ordinary uses of ! stay allowed
      for (const c of ['cmd /c type notes!.txt', 'cmd /v:on /c echo hi!', 'cmd /v:on /c type notes.txt', 'echo done!', 'git commit -m "wow!"']) assert.equal(policy.bashDenial(c, opts), null, plat + ' ' + c);
    });
  }
  asPlatform('linux', () => assert.equal(policy.bashDenial('cmd /c type .e!nv', opts), null, 'no /v:on: the ! stays'));
});

// --- review of #849, third round: a unit does not span commands; case patterns inside $( ); glued /v switches ---

test('a cmd variable unit does not reach into the next command', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      for (const c of ['cmd /v:on /c "echo a! & type .e!X!nv"', 'cmd /v:on /c "echo a!&type .e!X!nv"', 'cmd /c echo 5% & type .e%NOPE%nv', 'cmd /c "echo 5%&type .e%NOPE%nv"']) {
        assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c);
      }
      for (const c of ['echo 100% done & type notes.txt', 'echo 50% & echo 60% & type .env.example', 'cmd /v:on /c echo hello! & type notes.txt', 'cmd /v:on /c "type .env.example & echo done!"',
        'set PATH=%PATH%;C:\\tools & type notes.txt', 'echo %ProgramFiles(x86)%', 'dir "%ProgramFiles(x86)%"']) {
        assert.equal(policy.bashDenial(c, opts), null, plat + ' ' + c);
      }
    });
  }
  asPlatform('win32', () => assert.match(policy.bashDenial('type .e%A B%nv', opts) || '', DENIED, 'a name with a space is still read'));
});

test('a case pattern inside a command substitution does not end it early', () => {
  const { opts } = project();
  for (const c of ['cat .en$(case x in x) ;; esac)v', 'cat .en$(case x in x) : ;; esac)v', 'cat .en$(case x in a) :;; b) :;; esac)v', 'cat .en$(case x in x) case y in y) :;; esac;; esac)v',
    'cat .e${U:-$(case x in x) ;; esac)}nv']) {
    for (const plat of ['linux', 'win32']) asPlatform(plat, () => assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c));
  }
  assert.doesNotThrow(() => policy.bashDenial('cat .en$(case x in x) ;; ', opts));
  assert.equal(policy.bashDenial('cat notes.txt$(case x in x) ;; esac)', opts), null);
  assert.equal(policy.bashDenial('echo $(showcase x)', opts), null);
});

test('delayed expansion is seen also with glued switches', () => {
  const { opts } = project();
  for (const c of ['cmd /q/v:on /c type .e!nv', 'cmd /v:on/c type .e!nv']) assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
});

// --- review of #849, fourth round: names with spaces or ^ per command; case/esac with quoted words ---

test('a wide cmd variable name is read command by command', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      for (const c of ['cmd /v:on /c "echo a! & type .e!X Y!nv"', 'cmd /v:on /c "echo a!|type .e!X Y!nv"', 'cmd /c "echo 5% & type .e%A B%nv"', 'cmd /c echo 5% & type .e%A^B%nv',
        'cmd /c "echo 5%&type .e%A B%nv"']) {
        assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c);
      }
      for (const c of ['echo 100% done & type notes.txt', 'cmd /v:on /c "echo a! & type notes.txt"', 'cmd /c echo 5% & type .env.example & echo 6%']) assert.equal(policy.bashDenial(c, opts), null, plat + ' ' + c);
    });
  }
});

test('case and esac inside a command substitution: quoted words and comments are not keywords', () => {
  const { opts } = project();
  for (const c of ['cat .en$(case x in x) : "esac" ;; y) ;; esac)v', "cat .en$(case x in x) : 'esac' ;; y) ;; esac)v", 'cat .en$(case x in x) : \\esac ;; y) ;; esac)v',
    'cat .en$(case x in x) : ;; esac; case y in y) ;; esac)v', 'cat .en$(case x in a|b) : ;; (c) : ;; esac)v']) {
    for (const plat of ['linux', 'win32']) asPlatform(plat, () => assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c));
  }
  assert.doesNotThrow(() => policy.bashDenial('cat .en$(case x in x) "esac ' + 'case '.repeat(5000), opts));
  assert.equal(policy.bashDenial('cat notes.txt$(case x in x) "esac" ;; esac)', opts), null);
});

// --- review of #849, fifth round: the whole-line wide reading, and a fallback that spans lines and is linear ---

test('the wide cmd name reading also covers a name that holds an operator', () => {
  const { opts } = project();
  for (const plat of ['linux', 'win32']) {
    asPlatform(plat, () => {
      for (const c of ['cmd /c "type .e% & echo :~0,0%nv"', 'cmd /v:on /c "type .e! & echo :~0,0!nv"']) assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + c);
    });
  }
});

test('the case fallback spans lines and costs time in proportion to the text', () => {
  const { opts } = project();
  for (const c of ['cat .en$(case x in x) : "esac" ;; y)\n ;; esac)v', 'cat .en$(case x in x) :\n;; y) : "esac"\n;; esac)v']) {
    for (const plat of ['linux', 'win32']) asPlatform(plat, () => assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + JSON.stringify(c)));
  }
  const big = 'cat a$(case ' + '$('.repeat(40000) + ')'.repeat(40000);
  const t0 = Date.now();
  policy.bashDenial(big, opts);
  const ms = Date.now() - t0;
  assert.ok(ms < budget(2000), 'time: ' + ms + ' ms (limit ' + budget(2000) + ' ms on this machine)');
});

// --- review of #849, sixth round: esac only as a reserved word; the fallback anchored on each $( case ... esac ) ---

test('case inside a command substitution: a hyphenated word, extra substitutions and parentheses around it do not bring the bypass back', () => {
  const { opts } = project();
  const unit = 'case x in x) : my-esac ;; y) ;; esac';
  const multi = 'case x in\nx) : my-esac ;;\ny) ;; esac';
  const rows = [
    'cat $(echo a) .en$(' + unit + ')v', 'cat .en$(' + unit + ')v $(echo b)', '(cat .en$(' + unit + ')v)', 'cat .en$(' + unit + ')v # )', 'cat .en$(' + unit + ')v; echo ")"',
    'cat $(echo a) .en$(' + multi + ')v', 'cat .en$(' + multi + ')v $(echo b)', '(cat .en$(' + multi + ')v)', 'cat .en$(' + multi + ')v # )', 'cat .en$(' + multi + ')v; echo ")"',
    'echo $(date) && cat .en$(' + multi + ')v', 'cat .en$(' + unit + ')v\n(echo ok)', 'cat .en$(case x in x) : x-esac ;; esac)v', 'cat .en$(case x in x) : "a esac b" ;; esac)v',
  ];
  for (const c of rows) {
    for (const plat of ['linux', 'win32']) asPlatform(plat, () => assert.match(policy.bashDenial(c, opts) || '', DENIED, plat + ' ' + JSON.stringify(c)));
  }
  for (const c of ['echo $(date) && cat notes.txt', 'cat notes.txt$(' + unit + ')', '(echo ok); cat .env.example', 'echo $(case x in x) : ;; esac) && cat .envrc', 'cat $(echo a) $(echo b) notes.txt']) {
    assert.equal(policy.bashDenial(c, opts), null, JSON.stringify(c));
  }
  const many = 'cat a' + '$(case x in x) : ;; esac)'.repeat(2000);
  const t0 = Date.now();
  policy.bashDenial(many, opts);
  const ms = Date.now() - t0;
  assert.ok(ms < budget(2500), 'time: ' + ms + ' ms (limit ' + budget(2500) + ' ms on this machine)');
});

test('a glob in a later segment of a word that carries an expansion is read as a glob too', () => {
  const { opts } = project();
  asPlatform('linux', () => {
    for (const c of ['cat $PWD/.e*', 'cat ${DIR}/.e*', 'cat "$PWD"/.e*', 'cat a${IFS}./.e*', 'cat $PWD/.en?', 'cat ${DIR}/sub/.en[v]',
      'cat $PWD/?env', 'cat $PWD/.env*', 'cat $HOME/.ssh/id_*', 'cat $(pwd)/.e*', 'cp ${SRC}/.e* ${DST}/']) {
      assert.match(policy.bashDenial(c, opts) || '', /was not read because|\.env|credential|SSH|private key|protected/i, c);
    }
    // Benign look-alikes stay allowed.
    for (const c of ['cat $PWD/README.md', 'cat $PWD/src/*.js', 'cat ${DIR}/*.md', 'cat "$PWD"/docs/*.txt', 'cat $PWD/.e*.example', 'cat ${DIR}/n?tes.md',
      'cat $PWD/[a-c]*.txt', 'cat $PWD/*']) {
      assert.equal(policy.bashDenial(c, opts), null, c);
    }
  });
});
