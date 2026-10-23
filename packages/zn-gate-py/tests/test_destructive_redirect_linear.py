"""The fd-duplication rewrite (2>&1, >&2, <&-) must match the earlier quadratic regex and stay fast on long inputs."""

import random
import re
import time
import unittest

from zn_gate.destructive import _segments_of, check_command

_OLD = re.compile(r"(\d*[<>]+)&(\d+|-)", re.ASCII)

CORPUS = [
    "ls 2>&1", "cmd >&2", "cmd <&-", "cmd 3>&-", "cmd 2>&1 | tee out", "cmd &> out", "cmd &>> out", "cmd |& tee out",
    "a >&1 b >&-", "a 10>&12", "a >>&2", "a <>&3", "a >&- >&1", "a & b", "a && b", "a &1", "a & -", "a>&", "a 2> &1",
    "a >& file", 'echo "2>&1" && rm -rf /tmp/x', "a 2>&1; b 1>&2 &", "a &>&1", "a <&0 >&2 2>&-", "a >&1>&2", "a >&->&1",
    "a 1>&2&& b", ">&1", "&1", "<&-", "x\n2>&1\ny >&2",
]


def old_normalise(cmd: str) -> str:
    return _OLD.sub(r"\1_\2", cmd)


class RedirectLinearTests(unittest.TestCase):
    def test_matches_earlier_regex_on_real_forms(self):
        for cmd in CORPUS:
            for posix in (False, True):
                self.assertEqual(_segments_of(cmd, posix), _segments_of(old_normalise(cmd), posix), cmd)

    def test_matches_earlier_regex_on_random_strings(self):
        rnd = random.Random(12345)
        alphabet = list("<>&-120 |;a9")
        for _ in range(3000):
            cmd = "".join(rnd.choice(alphabet) for _ in range(rnd.randrange(24)))
            self.assertEqual(_segments_of(cmd), _segments_of(old_normalise(cmd)), repr(cmd))

    def test_long_redirection_runs_are_fast(self):
        size = 100 * 1024
        inputs = [
            "1" * size, "<" * size, ">" * size, "1>" * (size // 2), "<>" * (size // 2),
            "1" * (size // 2) + "<" * (size // 2), "1<" * (size // 2 - 1) + "&",
        ]
        for cmd in inputs:
            t0 = time.perf_counter()
            _segments_of(cmd)
            check_command(cmd)
            ms = (time.perf_counter() - t0) * 1000
            self.assertLess(ms, 1000, f"{cmd[:8]}... took {ms:.0f} ms")


if __name__ == "__main__":
    unittest.main()
