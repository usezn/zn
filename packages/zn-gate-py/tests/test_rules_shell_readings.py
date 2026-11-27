"""Variables, defaults, globs, braces and substitutions in a protected name, and the time the library takes on hostile input."""

import time

from zn_gate import rules


def blocked(text: str) -> bool:
    return rules.evaluate(text).rule == 'path:sensitive_file'


def test_assignments_defaults_and_unknown_variables():
    for t in ['F=.env; cat ${F}', 'F=.env; cat "$F"', 'D=~/.ssh; cat $D/id_ed25519', 'cat ${UNSET:-.env}', 'cat .e${E}nv',
              'A=.e; B=${A}nv; cat $B', 'cat ~/.ssh/$KEY', 'export F=.env; . $F']:
        assert blocked(t), t
    for t in ['F=notes.txt; cat $F', 'cat ${HOME}/notes.txt', 'echo ${PATH}', 'cat $FILE', 'cat $PROJECT/id_rsa']:
        assert not blocked(t), t


def test_globs_and_braces():
    for t in ['cat ~/.s*/id_ed25519', 'cat .en{v,}', 'cat .en[v]', 'cat .*', "find . -name '.e*' -exec cat {} +", 'cat ~/.aws/cred*']:
        assert blocked(t), t
    for t in ['cat *', 'cat *.md', 'cat ~/.ssh/*.pub', 'cat .e*.example', "find . -name '*.js'", "grep '.e*' notes.txt", 'cat README{,.bak}']:
        assert not blocked(t), t


def test_substitutions_and_ansi_c_escapes():
    for t in ['cat ~/.ssh/$(printf %s id_ed25519)', 'cat .e$(printf nv)', "cat $'\\x2eenv'", "cat $'\\056env'", 'cat .e`echo nv`']:
        assert blocked(t), t
    assert not blocked('echo $(printf hello)')


def test_hostile_input_stays_fast():
    texts = [
        'cat ' + '*' * 400 + 'x',
        'cat .' + '*a' * 200,
        'cat ' + '{a,b}' * 60,
        'cat ' + '{' * 400,
        'cat ' + '[a' * 300,
        '$(printf ' * 5000,
        'a=b; ' * 20000 + 'cat $a',
        'X=' + '$X' * 100 + '; cat $X',
        "$'" + '\\x41' * 300 + "'",
        '${A:-' * 3000,
        'cat .e* ' * 20000,
        '$' + 'a' * 100000,
    ]
    for t in texts:
        t0 = time.perf_counter()
        rules.evaluate(t)
        ms = (time.perf_counter() - t0) * 1000
        assert ms < 3000, (t[:20], ms)
