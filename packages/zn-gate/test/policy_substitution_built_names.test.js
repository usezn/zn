'use strict';

// A protected file name that a command substitution builds: printf with several arguments or escapes, and a filter or listing whose
// output zn cannot work out. Each is refused when the name is in a file position, and the ordinary substitutions stay allowed.
// Values are fake.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function project() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-subst-names-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(home, '.aws'));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIAFAKEFAKEFAKEFAKE\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'not a real key\n');
  fs.writeFileSync(path.join(proj, '.env'), 'API_TOKEN=fake-value-not-a-secret-0001\n');
  fs.writeFileSync(path.join(proj, 'notes.md'), 'nothing here\n');
  return { home, proj, opts: { home, cwd: proj, env: { HOME: home, PATH: '/usr/bin:/bin' } } };
}

const DENIED = /holds plain-text|was not read because|shell writes to .env|builds the path of a .env file|protected|private key|credentials/i;

test('printf with several arguments, a reused format or escapes builds a protected name: refused', () => {
  const { opts } = project();
  for (const c of [
    'cat $(printf %s%s .e nv)',
    "cat $(printf '%s%s' .e nv)",
    "cat $(printf '\\056env')",
    "cat $(printf '\\x2eenv')",
    "cat $(printf '\\x2e%s' env)",
    "cat $(printf '%b' '\\056env')",
    "cat $(printf '%s%s\\n' .e nv)",
    "cat $(printf '%c%c%c%c' . e n v)",
    'cat "$(printf %s%s .e nv)"',
    'cat `printf %s%s .e nv`',
    'cat $(echo -e "\\x2eenv")',
    'cat $(basename ./x/.env)',
    'cat $(basename /tmp/a/.env)',
    'echo x > $(printf %s%s .e nv)',
    'echo x >> $(printf %s%s .e nv)',
    'cat ~/.aws/$(printf %s%s cred entials)',
    'cat ~/.ssh/$(printf %s%s id_ ed25519)',
    'cat ~/.ssh/$(printf %s%s%s id_ ed 25519)',
    "cat ~/.ssh/$(printf '%s_%s' id ed25519)",
  ]) {
    assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  }
});

test('a substitution that filters or lists text close to a protected name in a file position is refused', () => {
  const { opts } = project();
  for (const c of [
    'cat $(echo .evn | tr v n)',
    'cat $(ls -a | grep env)',
    'cat $(ls -a | grep -m1 env)',
    'cat $(ls ~/.ssh | grep id_)',
    'cat ~/.ssh/$(ls ~/.ssh | grep ed25519)',
    'cat ~/.aws/$(ls ~/.aws | grep cred)',
    'cat $(echo .e nv | tr -d " ")',
    'echo x > $(echo .evn | tr v n)',
    'cat `echo .evn | tr v n`',
    'head -n 1 $(echo .evn | sed s/v/nv/ | cut -c1-4)',
  ]) {
    const d = policy.bashDenial(c, opts) || '';
    assert.match(d, /was not read because|holds plain-text|protected|credentials|private key/i, c);
  }
});

test('ordinary substitutions stay allowed, also in a file position', () => {
  const { opts } = project();
  for (const c of [
    'cat $(git rev-parse --show-toplevel)/README.md',
    'cat "$(git rev-parse --show-toplevel)/package.json"',
    'cd $(git rev-parse --show-toplevel)',
    'echo $(date)',
    'echo "built $(date +%s)"',
    'ls $(pwd)',
    'cat $(pwd)/notes.md',
    'cat "$(mktemp)"',
    'cat $(mktemp)',
    'cp $(mktemp) out.txt',
    'echo hi > $(mktemp)',
    'cat $(dirname $0)/notes.md',
    'cat $(basename ./x/notes.md)',
    'cat $(echo notes.md)',
    "cat $(printf '%s.%s' notes md)",
    'cat $(printf %s%s not es.md)',
    "cat $(printf '\\156otes.md')",
    'head -n 5 $(git ls-files | head -1)',
    'grep foo $(git ls-files)',
    "wc -l $(find . -name '*.js')",
    'rm $(ls *.tmp)',
    'tail -f $(ls -t | head -1)',
    'git add $(git ls-files -m)',
    'cat $(readlink -f notes.md)',
    'cat $(realpath notes.md)',
    'cat $(cat list.txt)',
    'cat $(find . -name "*.md" | head -1)',
    'cat $(ls | grep notes)',
    'cat $(ls | sort | tail -1)',
    'cat $(git diff --name-only | head -1)',
    'git commit -m "$(ls | grep env)"',
    'echo $(ls | grep env)',
    'cat .env.example',
  ]) {
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});

test('unicode and octal escapes in printf build a protected name: refused', () => {
  const { opts } = project();
  for (const c of [
    "cat $(printf '\\u002eenv')",
    "cat $(printf '\\U0000002eenv')",
    "cat $(printf '\\056%s' env)",
    "cat $(printf '%b' '\\0056env')",
    "cat $(printf '\\x2e\\u0065nv')",
  ]) {
    assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  }
});

test('a printf format takes three octal digits, the way bash does; %b and echo -e take a leading 0 and three more', () => {
  const { opts } = project();
  // bash: printf '\0056env' prints \005 and 6env, which is not a protected name.
  assert.equal(policy.bashDenial("cat $(printf '\\0056env')", opts), null);
  assert.match(policy.bashDenial("cat $(printf '%b' '\\0056env')", opts) || '', DENIED);
  assert.match(policy.bashDenial("cat $(echo -e '\\0056env')", opts) || '', DENIED);
});

test('more substitutions than zn works out are refused, not left unread', () => {
  const { opts } = project();
  const harmless = (n) => Array.from({ length: n }, () => 'echo $(pwd)').join('; ');
  const TOO_MANY = /chains more commands than zn checks/;
  assert.equal(policy.bashDenial(harmless(64), opts), null);
  for (const tail of ['cat $(printf %s%s .e nv)', 'cat $(echo vne. | rev)']) {
    assert.match(policy.bashDenial(harmless(64) + '; ' + tail, opts) || '', TOO_MANY, tail);
    assert.match(policy.bashDenial(harmless(80) + '; ' + tail, opts) || '', TOO_MANY, tail);
  }
  assert.match(policy.bashDenial(harmless(65), opts) || '', TOO_MANY);
});

test('more assignments than zn works out, printf -v included, are refused, not left unread', () => {
  const { opts } = project();
  const TOO_MANY = /chains more commands than zn checks/;
  const filler = (n) => Array.from({ length: n }, (_, i) => 'v' + i + '=x').join('; ');
  assert.equal(policy.bashDenial(filler(64) + '; cat notes.md', opts), null);
  assert.match(policy.bashDenial(filler(64) + "; printf -v f '%s%s' .e nv; cat $f", opts) || '', TOO_MANY);
  assert.match(policy.bashDenial(filler(70) + "; printf -v f '%s%s' .e nv; cat $f", opts) || '', TOO_MANY);
  assert.match(policy.bashDenial(filler(70) + '; cat notes.md', opts) || '', TOO_MANY);
});

test('a substitution that pipes text into a filter or runs inline code in a file position is refused', () => {
  const { opts } = project();
  for (const c of [
    'cat $(echo vne. | rev)',
    'cat $(echo LmVudg== | base64 -d)',
    "cat $(echo e n v | tr -d ' ' | sed 's/^/./')",
    'cat $(rev <<< vne.)',
    'cat $(echo 2e656e76 | xxd -r -p)',
    'cat $(echo vne. | cut -c1-4 | rev)',
    "cat $(python3 -c 'print(chr(46)+chr(101)+chr(110)+chr(118))')",
    "cat $(perl -e 'print chr(46).q(env)')",
    "cat $(node -e 'console.log(String.fromCharCode(46)+\"env\")')",
    'echo x > $(echo vne. | rev)',
  ]) {
    assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  }
});

test('printf -v builds a name in a variable that is read as a file', () => {
  const { opts } = project();
  for (const c of [
    "printf -v f '%s%s' .e nv; cat $f",
    "printf -v f '%s%s' .e nv; cat \"$f\"",
    "printf -v f '\\056env' && cat ${f}",
    'printf -v f %s .env; cat $f',
    "printf -v k '%s_%s' id ed25519; cat ~/.ssh/$k",
  ]) {
    assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  }
  for (const c of [
    "printf -v f '%s.%s' notes md; cat $f",
    'printf -v when %s "$(date +%s)"; echo $when',
    "printf -v n '%s' 5; head -n $n notes.md",
  ]) {
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});

test('lists and reads that are not filters stay allowed in a file position', () => {
  const { opts } = project();
  for (const c of [
    'cat $(sed -n 1p list.txt)',
    'cat $(ls -t | head -1)',
    'cat $(ls | sort | tail -1)',
    'cat $(git ls-files | head -1)',
    'cat $(find . -name "*.md" | sort | head -1)',
    'cat $(git diff --name-only | tail -1)',
    'cat $(git rev-parse --show-toplevel)/README.md',
  ]) {
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});

test('a plain echo may decode escapes (zsh, dash): both readings are judged, and echo -E stays literal', () => {
  const { opts } = project();
  for (const c of [
    "cat $(echo '\\056env')",
    "cat $(echo '\\x2eenv')",
    'cat $(echo "\\0056env")',
    "echo x > $(echo '\\056env')",
    "cat ~/.ssh/$(echo 'id_\\145d25519')",
  ]) {
    assert.match(policy.bashDenial(c, opts) || '', DENIED, c);
  }
  for (const c of [
    "cat $(echo 'notes\\\\ntxt')",
    "echo 'a\\tb'",
    "cat $(echo -E '\\056env')",
    "cat $(echo -E '\\x2eenv')",
  ]) {
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});
