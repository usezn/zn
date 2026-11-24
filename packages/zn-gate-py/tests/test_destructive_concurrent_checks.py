"""check_command keeps no state between calls: overlapping checks (threads) each get their own answer."""

import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from zn_gate import check_command

URL = "https://example.com/x"
RC = "destructive:rc_download"

# (command, expected rule or None for allow). The first group runs find -execdir from a folder that cannot be told, so a
# relative target with a folder in it is refused; the rest change or must not see that mode.
CASES = [
    ('find "$D" -execdir wget -O sub/dir/file ' + URL + " ;", RC),
    ("find . -execdir curl " + URL + " -o etc/profile ;", RC),
    ("find ~ -execdir curl -o out.txt " + URL + " ;", None),
    ("find /home/alice -execdir curl -o .zshrc " + URL + " ;", RC),
    ("find . -execdir curl " + URL + " -o out.txt ;", None),
    ("curl " + URL + " -o build/out.txt", None),
    ("find ~ -exec curl -o ~/.bashrc " + URL + " ;", RC),
]


def _run(command, expected, barrier):
    barrier.wait()
    res = check_command(command)
    return command, expected, (None if res.allowed else res.rule)


def test_overlapping_checks_do_not_share_the_execdir_mode():
    workers = 8
    old = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)  # switch threads as often as possible
    try:
        wrong = []
        for _ in range(60):
            barrier = threading.Barrier(workers)
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [
                    pool.submit(_run, c, e, barrier)
                    for c, e in (CASES * 2)[:workers]
                ]
                for f in futures:
                    command, expected, got = f.result()
                    if got != (expected):
                        wrong.append((command, expected, got))
        assert wrong == []
    finally:
        sys.setswitchinterval(old)
    # Nothing is left behind: a plain call afterwards gives the single-threaded answers.
    for command, expected in CASES:
        res = check_command(command)
        assert (None if res.allowed else res.rule) == expected
