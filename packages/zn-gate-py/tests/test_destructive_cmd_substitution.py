"""The text of a $( ) or backtick command substitution is a command Bash runs, even when its output only goes to echo or
another harmless program and even inside double quotes. check_command reads those bodies as commands. A $(( )) is
arithmetic, not a command, and text inside single quotes or after a backslash is not expanded. Mirrors
packages/zn-gate/test/destructive_cmd_substitution.test.js. Only the text is checked; nothing is run."""
from zn_gate.destructive import check_command


def test_destructive_command_in_substitution_blocked():
    for c in [
        'echo $(rm -rf ~)',
        'echo "$(rm -rf ~)"',
        'echo "$(rm -rf /)"',
        'echo `rm -rf ~`',
        'echo "`rm -rf ~`"',
        'echo "x $(date) $(rm -rf ~)"',
        'echo "$(echo "$(rm -rf ~)")"',
        'echo "${x:-$(rm -rf ~)}"',
        'echo "$(printf \')\' ; rm -rf ~)"',
        'echo "$(cd /tmp && rm -rf ~)"',
        'printf "%s" "$(sudo rm -rf ~)"',
        'x="$(rm -rf ~)"',
        'echo "$(( $(rm -rf ~) ))"',
        'echo "$(( 1 + $(rm -rf ~) ))"',
        'cat <(rm -rf ~)',
        'diff <(rm -rf ~) /dev/null',
    ]:
        res = check_command(c)
        assert res.verdict == "block", c
        assert res.rule == "destructive:rm_root_home", c


def test_harmless_substitution_allowed():
    for c in [
        'echo "$(date +%F)"',
        'echo "today is $(date)"',
        'echo "$(pwd)"',
        'echo "$(echo "hi")"',
        'echo "$(printf \')\')"',
        'echo "$(rm -rf ./build)"',
        'echo `date`',
        'diff <(date) <(pwd)',
        'echo "$(date)" "$(pwd)"',
    ]:
        assert check_command(c).verdict == "allow", c


def test_text_bash_does_not_expand_is_not_a_command():
    for c in [
        "echo '$(rm -rf ~)'",
        "echo '$(' ; echo 'rm -rf ~)'",
        "echo \"'$(pwd)'\"",
        'echo "a \\$(rm -rf ~)"',
        'echo "(rm -rf ~)"',
    ]:
        assert check_command(c).verdict == "allow", c


def test_arithmetic_is_not_a_command():
    for c in ['echo $((1+2))', 'echo "$((1+2))"', 'echo $(( 1 + 2 ))', 'echo "$(( $(date +%s) - 5 ))"', 'echo "$((rm -rf ~))"']:
        assert check_command(c).verdict == "allow", c


def test_parenthesis_hidden_in_case_comment_heredoc_or_ansi_c_quote_is_still_read():
    for c in [
        'echo "$(case a in a) rm -rf ~ ;; esac)"',
        'echo "$( # )\nrm -rf ~\n)"',
        'echo "$(cat <<E\n)\nE\nrm -rf ~\n)"',
        "echo $'\\'' \"$(rm -rf ~)\" $'\\''",
        'echo "$(echo ${x//)/y}; rm -rf ~)"',
        'echo "$(echo ${x:-)}; rm -rf ~)"',
        'echo "$(echo `echo )` ; rm -rf ~)"',
    ]:
        res = check_command(c)
        assert res.verdict == "block", c
        assert res.rule == "destructive:rm_root_home", c


def test_similar_substitutions_that_run_nothing_destructive_stay_allowed():
    for c in [
        'echo "$(case $x in a) echo hi ;; esac)"',
        'echo "$(date) # not a comment"',
        "echo $'\\'' \"$(date)\" $'\\''",
        'echo "$(cat <<< hi)"',
        'echo "$(echo ${#PATH})"',
        'echo "$(echo ${HOME})"',
        'echo "$(echo `date`)"',
    ]:
        assert check_command(c).verdict == "allow", c
