"""Technical detail only for ZN_VERBOSE=1 or a DEBUG value that names zn, as in the
Node.js package."""

import contextlib
import io
import os
import unittest
from unittest import mock

from zn_gate import client
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


class TestCloudErrorDetail(unittest.TestCase):
    """The client's cloud error notice follows the same rule: DEBUG=* stays quiet, DEBUG=zn shows it."""

    def _stderr_with(self, debug):
        env = {"ZN_API_KEY": "fake-key-for-tests", "ZN_CLOUD": "1", "DEBUG": debug}
        err = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(client, "analyze_cloud", side_effect=RuntimeError("cloud down")), \
                contextlib.redirect_stderr(err):
            os.environ.pop("ZN_VERBOSE", None)
            os.environ.pop("ZN_LOCAL_ONLY", None)
            res = client.analyze("hello there")
        self.assertEqual(res["verdict"], "allow")
        return err.getvalue()

    def test_debug_star_prints_nothing(self):
        self.assertEqual(self._stderr_with("*"), "")

    def test_debug_zn_prints_the_notice(self):
        self.assertIn("Cloud gate error", self._stderr_with("zn"))


if __name__ == "__main__":
    unittest.main()
