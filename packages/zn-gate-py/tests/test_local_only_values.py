"""ZN_LOCAL_ONLY: 1, true, yes and on (any case) keep the cloud off; an unknown value keeps it off and warns once
(same cases as packages/zn-gate/test/local_only_values.test.js)."""
import os
import unittest
from unittest import mock

from zn_gate import client
from zn_gate.client import is_cloud_enabled, local_only_env

FAKE_KEY = "zn_test_" + "notarealkey_0000"


class TestLocalOnlyValues(unittest.TestCase):
    def setUp(self):
        client._LOCAL_ONLY_WARNED.clear()

    def _cloud(self, value):
        env = {"ZN_API_KEY": FAKE_KEY, "ZN_CLOUD": "1"}
        if value is not None:
            env["ZN_LOCAL_ONLY"] = value
        with mock.patch.dict(os.environ, env, clear=True):
            return is_cloud_enabled()

    def test_truthy_values_force_local(self):
        for v in ("1", "true", "TRUE", "True", "yes", "YES", "on", "On", " 1 "):
            with self.subTest(v=v):
                self.assertFalse(self._cloud(v))

    def test_off_values_leave_cloud_on(self):
        for v in (None, "", "0", "false", "no", "off", "OFF"):
            with self.subTest(v=v):
                self.assertTrue(self._cloud(v))

    def test_unknown_value_keeps_local_only_on_and_warns_once(self):
        with self.assertLogs("zn_gate", level="WARNING") as cm:
            self.assertFalse(self._cloud("maybe"))
            self.assertFalse(self._cloud("maybe"))
        self.assertEqual(len(cm.output), 1)
        self.assertIn("ZN_LOCAL_ONLY", cm.output[0])

    def test_known_values_do_not_warn(self):
        with self.assertNoLogs("zn_gate", level="WARNING"):
            for v in ("1", "true", "no", "0", ""):
                with mock.patch.dict(os.environ, {"ZN_LOCAL_ONLY": v}):
                    local_only_env()

    def test_local_only_argument_still_wins(self):
        with mock.patch.dict(os.environ, {"ZN_API_KEY": FAKE_KEY, "ZN_CLOUD": "1"}, clear=True):
            self.assertFalse(is_cloud_enabled(local_only=True))


if __name__ == "__main__":
    unittest.main()
