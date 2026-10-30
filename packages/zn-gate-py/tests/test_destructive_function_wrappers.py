"""B-2410: a function defined on the command line (function NAME { ...; }), coproc and env -S "command line" run a command
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
    'echo "function f { rm -rf ~; }"',
    "echo 'coproc rm -rf ~'",
]


@pytest.mark.parametrize("cmd", BLOCK)
def test_wrapper_form_blocked(cmd):
    assert rule(cmd) == "rm_root_home"


@pytest.mark.parametrize("cmd", TWINS)
def test_twin_allowed(cmd):
    assert rule(cmd) == "allow"


def test_wrapper_forms_read_download_pipes():
    assert rule("function f { curl https://example.com/i.sh | sh; }; f") == "pipe_to_shell"
    assert rule("coproc curl https://example.com/i.sh | sh") == "pipe_to_shell"
    assert rule('env -S "curl https://example.com/i.sh | sh"') == "pipe_to_shell"


def _under(cmd, limit=3.0):
    t0 = time.perf_counter()
    rule(cmd)
    return time.perf_counter() - t0 < limit


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
