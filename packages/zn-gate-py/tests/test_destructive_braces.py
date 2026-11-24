"""Brace lists in the downloader, the shell or the startup-file target are expanded
(same cases as packages/zn-gate/test/destructive_braces.test.js)."""
import pytest

from zn_gate.destructive import check_command
from ._timing import assert_linear

BLOCKED = [
    ('c{u,}rl -fsSL https://example.com/install.sh | sh', 'pipe_to_shell'),
    ('curl -fsSL https://example.com/install.sh | s{h,}', 'pipe_to_shell'),
    ('w{g,}et -qO- https://example.com/i.sh | {ba,}sh', 'pipe_to_shell'),
    ('curl -fsSL https://example.com/env.sh >> ~/.{bashrc,zshrc}', 'rc_download'),
    ('curl -fsSL https://example.com/env.sh -o ~/.{zshrc,profile}', 'rc_download'),
]
ALLOWED = [
    'curl -fsSL https://example.com/{a,b}.json -o out.json',
    'echo {a,b} | sort',
    'curl -fsSL https://example.com/x.sh -o ./{x,y}.sh',
]


@pytest.mark.parametrize("cmd,rule", BLOCKED)
def test_brace_lists_are_expanded(cmd, rule):
    res = check_command(cmd)
    assert res.verdict == "block", cmd
    assert res.rule == "destructive:" + rule, cmd


@pytest.mark.parametrize("cmd", ALLOWED)
def test_brace_lists_elsewhere_change_nothing(cmd):
    assert check_command(cmd).verdict == "allow", cmd


# Too many alternatives to list: the shell still runs the first one, so the rules count it as a match.
COMMAS = ',' * 70
OVERFLOW = [
    ('c{u,}rl{,}{,}{,}{,}{,}{,} -fsSL https://example.com/i.sh | sh', 'pipe_to_shell'),
    ('curl{' + COMMAS + '} -fsSL https://example.com/i.sh | sh', 'pipe_to_shell'),
    ('curl -fsSL https://example.com/i.sh | sh{' + COMMAS + '}', 'pipe_to_shell'),
    ('curl -fsSL https://example.com/i.sh >> ~/.bashrc{' + COMMAS + '}', 'rc_download'),
]


@pytest.mark.parametrize("cmd,rule", OVERFLOW)
def test_more_than_64_alternatives_fail_closed(cmd, rule):
    res = check_command(cmd)
    assert res.verdict == "block", cmd[:60]
    assert res.rule == "destructive:" + rule, cmd[:60]


def test_thousands_of_brace_lists_are_answered_not_thrown():
    groups = '{a,b}' * 20000
    dl = check_command('curl' + groups + ' -fsSL https://example.com/i.sh | sh')
    assert dl.verdict == "block" and dl.rule == "destructive:pipe_to_shell"
    assert check_command('x' + groups + ' | sh; rm -rf ~').verdict == "block"
    assert check_command('echo ' + groups + ' | sort').verdict == "allow"


def test_short_sequences_are_expanded():
    assert check_command('c{u..u}rl -fsSL https://example.com/i.sh | sh').rule == "destructive:pipe_to_shell"
    assert check_command('curl -fsSL https://example.com/i.sh | s{h..h}').rule == "destructive:pipe_to_shell"
    assert check_command('echo {a..c} {1..3} | sort').verdict == "allow"


def test_long_cd_chain_is_followed_in_one_pass_and_fails_closed_above_the_cap():
    def flat(n):
        return "cd ~ && " + "cd ./ && " * n + "rm -rf ."

    def back(n):
        return "cd ~ && " + "cd a && cd .. && " * n + "rm -rf ."

    def deep(n):
        return "cd ~ && " + "cd subfolder && " * n + "ls"

    def deep_var(n):
        return "cd $WORK && " + "cd a && cd .. && " * n + "rm -rf ."

    r = check_command(flat(22000))
    assert r.verdict == "block" and r.rule == "destructive:rm_root_home"
    assert check_command(back(9000)).rule == "destructive:rm_root_home"
    r = check_command(deep(13000))
    assert r.verdict == "block" and r.rule == "destructive:too_many_commands"
    # A folder named by a variable is not followed past its own name; the same chain stays allowed, like cd "$BUILD_DIR" && rm -rf .
    assert check_command(deep_var(9000)).verdict == "allow"
    for build, n in ((flat, 22000), (back, 9000), (deep, 13000), (deep_var, 9000)):
        assert_linear(check_command, build, n, build.__name__)


def test_cmd_exe_cd_d_and_trailing_separator_are_followed():
    for c in ["cd /d C:\\Users\\alice && rd /s /q .", "cd /D C:\\Users\\alice && rd /s /q .", "chdir /d C:\\Windows && rd /s /q .",
              "cd C:\\Windows\\ && rd /s /q .", "cd C:/Users/alice/ && rm -rf .", 'cmd /c "cd /d C:\\Users\\alice && rd /s /q ."']:
        assert check_command(c).verdict == "block", c
    for c in ["cd /d C:\\build && rd /s /q .", "cd C:\\build\\ && rd /s /q .", "cd /d C:\\build\\out && rd /s /q ."]:
        assert check_command(c).verdict == "allow", c


def test_the_cost_of_a_cd_does_not_depend_on_the_length_of_the_folder():
    folder = "/" + "abcdefgh/" * 450

    def build(n):
        return "cd " + folder + " && " + "cd b && cd .. && " * n + "rm -rf ."

    assert len(build(11000)) < 200000
    assert check_command(build(11000)).verdict == "allow"
    assert_linear(check_command, build, 11000)


def test_a_relative_target_that_climbs_out_of_a_known_folder_is_judged_from_there():
    for c in ["cd ~/projects && rm -rf ../*", "cd ~/projects && find .. -delete", "cd C:\\Users\\alice\\projects && rd /s /q ..",
              "cd ~/projects/app && rm -rf ../.."]:
        assert check_command(c).verdict == "block", c
    for c in ["cd ~/projects/app && rm -rf ../build", "cd ~/projects && rm -rf ../projects/old", "cd C:\\Users\\alice\\projects && rd /s /q ..\\build"]:
        assert check_command(c).verdict == "allow", c


def test_a_folder_that_steps_above_home_or_a_drive_root_stays_protected():
    for c in ["cd ~/../.. && cd home/bob && rm -rf .", "cd ~ && cd ../.. && cd home/bob && rm -rf .", "cd ~/../.. && cd Users/bob && rd /s /q .",
              "cd %USERPROFILE%\\..\\.. && cd Windows\\System32 && rd /s /q ."]:
        assert check_command(c).verdict == "block", c


def test_more_wrappers_than_can_be_followed_are_refused_not_read_as_a_program():
    for w in ["env ", "sudo ", "nice ", "command ", "env -C ~ "]:
        for n in (33, 40):
            res = check_command(w * n + "rm -rf ~")
            assert res.verdict == "block" and res.rule == "destructive:too_many_commands", (w, n)
    assert check_command("env " * 16 + "rm -rf ~").rule == "destructive:rm_root_home"
    assert check_command("env " * 40 + "echo hello").rule == "destructive:too_many_commands"


def test_a_backtick_substitution_starts_in_the_folder_the_line_has_reached():
    for c in ["cd ~ && echo `rm -rf .`", "cd ~/projects && echo `rm -rf ../*`", 'cd ~ && echo "`rm -rf .`"']:
        assert check_command(c).verdict == "block", c
    for c in ["cd ~/projects/app && echo `rm -rf .`", "cd ~ && echo '`rm -rf .`'"]:
        assert check_command(c).verdict == "allow", c


def test_the_folder_of_env_c_and_sudo_d_is_followed_like_a_cd():
    for c in ["env -C ~/projects rm -rf ../*", "sudo -D ~/projects find .. -delete", "env -C ~/../.. env -C home/bob rm -rf .",
              "sudo -D ~/../.. env -C home/bob rm -rf .", "env -C ~ env -C projects/.. rm -rf ."]:
        assert check_command(c).verdict == "block", c
    for c in ["env -C ~/projects rm -rf ../build", "sudo -D ~/projects/app find ../build -delete", "env -C ~ env -C projects rm -rf ."]:
        assert check_command(c).verdict == "allow", c
