"""A function defined on the command line (function NAME { ...; }), coproc and env -S "command line" run a command
through a wrapper. Each wrapper is read through, so the same rule fires as for the plain command. The body of a function
defined in the same line is checked whether or not it is called. Mirrors
packages/zn-gate/test/destructive_function_wrappers.test.js. Only the text is checked; nothing is run."""
import time

import pytest

from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


BLOCK = [
    "f() { rm -rf ~; }; f",
    "f(){ rm -rf ~; }; f",
    "f () { rm -rf ~; } ; f",
    "function f { rm -rf ~; }; f",
    "function f { rm -rf ~; } ; f",
    "function f() { rm -rf ~; }; f",
    "function f () { rm -rf ~; }; f",
    "f() { echo a; rm -rf ~; echo b; }; f",
    "function f { echo a; rm -rf ~; echo b; }; f",
    "function f { cd /srv/app; rm -rf /; }; f",
    "function f { rm -rf ~; }",
    "function f { rm -rf $HOME; }; echo done",
    "function build_all { rm -rf /etc; }; build_all",
    "function f { sudo rm -rf /usr; }; f",
    "function a { echo hi; }; function b { rm -rf ~; }; a; b",
    "coproc rm -rf ~",
    "coproc NAME { rm -rf ~; }",
    "coproc { rm -rf ~; }",
    "coproc NAME { echo a; rm -rf /; }",
    "coproc sudo rm -rf /etc",
    "coproc rm -rf ~ ; echo started",
    'env -S "rm -rf ~"',
    "env -S 'rm -rf /'",
    'env -S"rm -rf ~"',
    'env -iS "rm -rf ~"',
    'env --split-string="rm -rf ~"',
    "env --split-string 'rm -rf /'",
    'env -S "FOO=1 rm -rf ~"',
    'env FOO=1 -S "rm -rf $HOME"',
    'env -S "rm -rf" ~',
    'env -S "rm -r" -S "-f /"',
    'sudo env -S "rm -rf /usr"',
    "env -S \"sh -c 'rm -rf ~'\"",
    # env options as GNU env reads them: clusters, long-option prefixes, options inside the -S string.
    'env -0S "rm -rf ~"',
    "env -iS'rm -rf ~'",
    'env -vS"rm -rf ~"',
    "env -0S 'rm -rf /'",
    "env -i0S 'rm -rf ~'",
    "env --split-s 'rm -rf ~'",
    "env --split-str 'rm -rf ~'",
    "env --split-string 'rm -rf ~'",
    "env --split-s='rm -rf /'",
    "env --s 'rm -rf ~'",
    "env -S '-i rm -rf ~'",
    "env -S '-u X rm -rf ~'",
    "env -S '-C / rm -rf .'",
    "env -S '-iv rm -rf ~'",
    "env -u X -S 'rm -rf ~'",
    "env -uX -S 'rm -rf ~'",
    "env --unset X --split-s 'rm -rf ~'",
    "env -C /srv -S 'rm -rf ~'",
    "env -C/srv -iS 'rm -rf ~'",
    "env -S 'rm\\_-rf\\_~'",
    "env -S 'FOO=1 -i rm -rf ~'",
    "sudo env -vS'rm -rf /usr'",
    'env -S \'env --split-s "rm -rf ~"\'',
]

TWINS = [
    "f() { ls; }; f",
    "f(){ echo hi; }; f",
    "function f { ls; }; f",
    "function f() { ls -la; }; f",
    "function f { rm -rf ./build; }; f",
    "function f { rm -rf node_modules dist; }; f",
    "function f { cd /srv/app; ls; }; f",
    "coproc ls",
    "coproc NAME { ls; }",
    "coproc { sleep 1; }",
    "coproc rm -rf ./build",
    'env -S "ls -la"',
    "env -S 'echo hi'",
    'env --split-string="ls -la"',
    'env -iS "ls"',
    'env -S "rm -rf ./build"',
    'env -S "rm -f notes.txt"',
    'env -S "curl -fsSL https://example.com/i.sh -o install.sh"',
    "env -S 'ls -la'",
    "env -0S 'ls -la'",
    "env -iS'ls -la'",
    "env -vS'echo hi'",
    "env --split-s 'ls -la'",
    "env --split-str 'echo hi'",
    "env -S '-i ls -la'",
    "env -S '-u X echo hi'",
    'env -u X ls -la',
    "env -uX -S 'ls'",
    "env -S 'ls\\_-la'",
    "env -C /srv -iS 'ls -la'",
    "env -iS'rm -rf ./build'",
    "env -S '-i rm -rf ./build'",
    'echo "function f { rm -rf ~; }"',
    "echo 'coproc rm -rf ~'",
]


@pytest.mark.parametrize("cmd", BLOCK)
def test_wrapper_form_blocked(cmd):
    assert rule(cmd) == "rm_root_home"


@pytest.mark.parametrize("cmd", TWINS)
def test_twin_allowed(cmd):
    assert rule(cmd) == "allow"


def test_env_option_forms_stay_linear():
    n = 200 * 1024
    t0 = time.process_time()
    rule("env -S '" + "-i " * (n // 3) + "ls'")
    rule("env " + "-0S x " * (n // 6) + "ls")
    rule("env -" + "i" * n + "S ls")
    rule("env --split-s " + "'ls' " * (n // 5))
    assert time.process_time() - t0 < 12


def test_wrapper_forms_read_download_pipes():
    assert rule("function f { curl https://example.com/i.sh | sh; }; f") == "pipe_to_shell"
    assert rule("coproc curl https://example.com/i.sh | sh") == "pipe_to_shell"
    assert rule('env -S "curl https://example.com/i.sh | sh"') == "pipe_to_shell"


def _under(cmd, limit=3.0):
    t0 = time.process_time()
    rule(cmd)
    return time.process_time() - t0 < limit


def test_200kb_wrapper_forms_stay_linear():
    n = 200 * 1024
    assert _under("function f { " + "ls; " * ((n - 40) // 4) + "}; f")
    assert _under("function f { ls; }; " * (n // 20))
    assert _under("function f " * (n // 11) + "ls")
    assert _under("coproc " * (n // 7) + "ls")
    assert _under("coproc N { ls; }; " * (n // 18))
    assert _under('env -S "' + "ls " * ((n - 20) // 3) + '"')
    assert _under('env -S "ls -la"; ' * (n // 17))
    assert _under("env " + "-S a " * (n // 6) + "-- " + "x " * 1000)
    assert _under('env -S "env -S \\"env -S \\\\\\"ls\\\\\\"\\""' + " x" * (n // 2))
