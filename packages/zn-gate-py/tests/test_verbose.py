"""Technical detail only for ZN_VERBOSE=1 or a DEBUG value that names zn, as in the
Node.js package."""

import unittest

from zn_gate.verbose import is_verbose


class TestVerbose(unittest.TestCase):
    def test_zn_verbose(self):
        self.assertTrue(is_verbose({"ZN_VERBOSE": "1"}))
        self.assertFalse(is_verbose({"ZN_VERBOSE": "0"}))
        self.assertFalse(is_verbose({"ZN_VERBOSE": "true"}))

    def test_debug_naming_zn(self):
        for v in ["zn", "zn*", "zn:*", "zn-gate", "zn-gate*", "zn-gate:*", "express:*,zn", "a zn:x", "a, zn"]:
            self.assertTrue(is_verbose({"DEBUG": v}), v)

    def test_debug_from_other_tools(self):
        for v in ["*", "express:*", "1", "true", "znx", "myzn", "zn_other", "", "a:zn"]:
            self.assertFalse(is_verbose({"DEBUG": v}), v)
        self.assertFalse(is_verbose({}))


if __name__ == "__main__":
    unittest.main()
