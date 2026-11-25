"""Work bound of nested shells in the destructive-command check (twin of destructive_nesting_cost.test.js).

Each `sh -c` level and each backtick level can be read again (whole-line backtick reading, per-segment backtick reading,
the backslash reading), and the escaping doubles at each level, so the deepest input that is still read, near the size
cap, is where the work could grow fastest. These tests check that such inputs are read in full (a benign one is allowed,
a risky call at the end is found by its own rule), that the work stays linear in the input size, and that one level
more is refused.
"""

import re
import unittest

from zn_gate.destructive import check_command
from ._timing import assert_linear


def sh_wrap(s):
    # One more level of double-quoted `sh -c`: \ " ` $ are escaped, so backslashes double at each level.
    return 'sh -c "' + re.sub(r'([\\"`$])', r"\\\1", s) + '"'


def tick_wrap(s):
    # One more level of backticks: \ and ` are escaped inside the backticks.
    return "echo `" + re.sub(r"([\\`])", r"\\\1", s) + "`"


def nest(wrap, levels):
    def run(s):
        for _ in range(levels):
            s = wrap(s)
        return s
    return run


PLAIN = "echo a c\\d; "  # a backslash in every segment
TICKED = "echo a`echo b`c\\d; "  # and a backtick level of its own

# The deepest shapes that are still read: three levels in all, counting a backtick inside the segment as a level.
READ = [
    ("sh -c x3", nest(sh_wrap, 3), PLAIN),
    ("backticks x3", nest(tick_wrap, 3), PLAIN),
    ("sh -c, backticks, sh -c", lambda s: sh_wrap(tick_wrap(sh_wrap(s))), PLAIN),
    ("sh -c x2 with backticks inside", nest(sh_wrap, 2), TICKED),
    ("backticks x2 with backticks inside", nest(tick_wrap, 2), TICKED),
]
# One level more than the limit: refused whatever it holds.
PAST = [
    ("sh -c x4", nest(sh_wrap, 4), PLAIN),
    ("backticks x4", nest(tick_wrap, 4), PLAIN),
    ("sh -c x3 with backticks inside", nest(sh_wrap, 3), TICKED),
]


def size_for(wrap, seg, budget=150 * 1024):
    # Sized so the largest input stays under the 200 KB command cap for every shape (the escaping grows with depth).
    return max(64, budget // len(wrap(seg)))


class NestedShellWorkBound(unittest.TestCase):
    def test_the_deepest_nested_shells_that_are_read_are_read_in_full(self):
        for label, wrap, seg in READ:
            for k in (1, 50, size_for(wrap, seg)):
                self.assertEqual(check_command(wrap(seg * k + "echo done")).verdict, "allow", "%s benign k=%d" % (label, k))
                risky = check_command(wrap(seg * k + "rm -rf /"))
                self.assertEqual(risky.verdict, "block", "%s risky k=%d" % (label, k))
                self.assertNotEqual(risky.rule, "destructive:too_many_commands", "%s risky k=%d own rule" % (label, k))

    def test_one_nesting_level_past_the_limit_is_refused(self):
        for label, wrap, seg in PAST:
            for k in (1, 50):
                r = check_command(wrap(seg * k + "echo done"))
                self.assertEqual(r.verdict, "block", "%s k=%d" % (label, k))
                self.assertEqual(r.rule, "destructive:too_many_commands", "%s k=%d" % (label, k))

    def test_nested_shells_near_the_size_cap_stay_linear(self):
        # Python reads more slowly than Node: a smaller budget keeps the test short and still well past the small sizes.
        for label, wrap, seg in READ + PAST:
            assert_linear(check_command, lambda k, w=wrap, s=seg: w(s * k + "echo done"), size_for(wrap, seg, 80 * 1024), label)


if __name__ == "__main__":
    unittest.main()
