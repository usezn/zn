"""A cd in a branch that may not run (if/else, case, after && or ||) leaves the folder it may have been in before or the one
it names: a protected folder reached in one branch stays protected after a cd to another folder in a later branch. A cd to a
folder a variable names leaves "." and ".." possibly protected. Mirrors test/destructive_cd_in_branches.test.js. Only
example paths; nothing is run."""
import time

from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


def test_a_protected_folder_reached_in_one_branch_stays_protected_after_a_cd_in_another_branch():
    assert rule("if [ -d x ]; then cd ~; else cd /tmp/example; fi; rm -rf .") == "rm_root_home"
    assert rule("if [ -d x ]; then cd /tmp/example; else cd ~; fi; rm -rf .") == "rm_root_home"
    assert rule("if [ -d x ]; then cd ~; fi; rm -rf .") == "rm_root_home"
    assert rule("if a; then cd /tmp/a; elif b; then cd ~; else cd /tmp/c; fi; rm -rf .") == "rm_root_home"
    assert rule("case $A in a) cd ~;; b) cd /tmp/example;; esac; rm -rf .") == "rm_root_home"
    assert rule("cd /tmp/example || cd ~; rm -rf .") == "rm_root_home"
    assert rule("[ -d x ] && cd ~; rm -rf .") == "rm_root_home"
    assert rule("cd ~ || cd /tmp/example; rm -rf .") == "rm_root_home"
    assert rule("if x; then cd ~; else cd /tmp/example; fi; find . -delete") == "rm_root_home"


def test_a_branch_that_moves_to_a_project_folder_only_is_not_protected():
    assert rule("if a; then cd /tmp/a; else cd /tmp/b; fi; rm -rf .") == "allow"
    assert rule("case $A in a) cd /tmp/a;; b) cd /tmp/b;; esac; rm -rf .") == "allow"
    assert rule("if [ -d app ]; then cd app; fi; rm -rf build/") == "allow"
    assert rule("if [ -d app ]; then cd app; fi; rm -rf .") == "allow"
    assert rule("cd /tmp/example/app && rm -rf build/") == "allow"
    assert rule("cd /tmp/example && (cd ~; ls); rm -rf .") == "allow"


def test_a_cd_to_a_folder_a_variable_names_makes_the_folders_above_it_possibly_protected():
    assert rule('cd "$X" && rm -rf ..') == "rm_root_home"
    assert rule("cd $X; rm -rf ..") == "rm_root_home"
    assert rule("cd ${PROJECT}; rm -rf ..") == "rm_root_home"
    assert rule('cd "$X/proj" && rm -rf ../..') == "rm_root_home"
    assert rule('if [ -d x ]; then cd "$X"; fi; rm -rf ..') == "rm_root_home"
    assert rule('cd "$X" && find .. -delete') == "rm_root_home"


def test_the_variable_folder_itself_and_a_name_below_it_are_not_protected():
    assert rule('cd "$X" && rm -rf build/') == "allow"
    assert rule('cd "$X" && rm -rf .') == "allow"
    assert rule('cd "$X/proj" && rm -rf .') == "allow"
    assert rule('cd "$X/proj" && rm -rf ..') == "allow"
    assert rule('cd "$(mktemp -d)" && rm -rf .') == "allow"
    assert rule("rm -rf .") == "allow"
    assert rule("rm -rf ..") == "allow"


def test_a_long_chain_of_branches_is_read_in_linear_time():
    chain = "if x; then cd /tmp/example; fi; " * 400
    t0 = time.time()
    r = rule(chain + "rm -rf .")
    assert time.time() - t0 < 2
    assert r in ("allow", "too_many_commands")
    t1 = time.time()
    rule("if x; then cd ~; fi; " + chain + "rm -rf .")
    assert time.time() - t1 < 2
