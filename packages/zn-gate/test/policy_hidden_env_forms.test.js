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
  assert.ok(Date.now() - t0 < 2000, 'time: ' + (Date.now() - t0) + ' ms');
});
