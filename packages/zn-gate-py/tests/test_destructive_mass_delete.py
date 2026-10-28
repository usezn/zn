"""Mass deletes on the home folder, the filesystem root or a top-level system folder that the rm_root_home rule used to
let through: find with a test plus a delete action, find piped to xargs rm, and git clean -f there. The same cases are in
zn-gate/test/destructive_mass_delete.test.js. The strings are test data: they are never run."""

from zn_gate.destructive import check_command

BLOCKED = [
    "find ~ | xargs sudo rm",
    "find ~ -print0 | xargs -0 env rm",
    "find / | xargs nice rm -f",
    "find ~ | xargs timeout 5 rm",
    "find ~ -exec sudo rm -rf {} +",
    "find ~ -exec env rm {} \\;",
    "find / -exec nice rm {} +",
    "find ~ -exec sh -c 'rm -rf {}' \\;",
    "find ~ | xargs sh -c 'rm -f \"$@\"' _",
    "find -L ~ -delete",
    "find -H / -name x -delete",
    "find -P -L ~ -exec rm {} +",
    "find -D tree ~ -delete",
    "find -O3 / -delete",
    'find ~ -name "*.bak" -delete',
    'find / -name "*" -delete',
    "find $HOME -type f -mtime +30 -exec rm -f {} +",
    'find /usr -name "*.so" -execdir rm {} \\;',
    'find ~ -name "*.log" -ok rm {} \\;',
    "find /home/alice -type f -exec /bin/rm -f {} +",
    'find ~ -name "*.log" | xargs rm -f',
    "find / -type f -print0 | xargs -0 rm",
    'find ~ -name "*.tmp" -print0 | sudo xargs -0 -n 50 -P 4 rm -f',
    "find $HOME -type f | xargs -I {} rm {}",
    "git -C ~ clean -fdx",
    "git -C $HOME clean -ffdx",
    "git -C / clean -fd",
    "git --work-tree=/home/alice clean -fx",
    "git -c core.quotepath=off -C ~ clean -f -d -x",
    "git clean -fdx ~",
    "sudo git -C /usr clean -fdx",
]

ALLOWED = [
    "find ~ | xargs sudo ls -la",
    "find ~ -exec sh -c 'echo {}' \\;",
    "find ./build | xargs sudo rm",
    "find ~ -exec env cat {} +",
    "find -L ~/projects/app/build -delete",
    "find -L ~ -name x -print",
    "find -O3 ./build -delete",
    'find ~ -name "*.bak" -print',
    'find / -name "*.conf" -type f 2>/dev/null',
    'find . -name "*.pyc" -delete',
    'find ~/projects/app -name "*.log" -delete',
    'find /var/log -name "*.gz" -mtime +14 -delete',
    'find . -name "*.tmp" -print0 | xargs -0 rm',
    'find ~ -name "*.log" | xargs ls -la',
    "xargs -a files.txt rm",
    "git clean -fdx",
    "git clean -n -fdx",
    "git -C ~ clean -n -fdx",
    "git -C ~ clean -fdx --dry-run",
    "git clean -i",
    "git -C ~/projects/app clean -fdx",
    "git -C ~ status",
    "git -C src clean -fdx",
]


def test_mass_deletes_on_home_root_or_system_are_blocked() -> None:
    for c in BLOCKED:
        r = check_command(c)
        assert r.verdict == "block", c
        assert r.rule == "destructive:rm_root_home", c


def test_look_alikes_stay_allowed() -> None:
    for c in ALLOWED:
        assert check_command(c).verdict == "allow", c
