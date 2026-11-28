"""A malformed API key counts as no key: cloud off, as in the Node.js client (lib/cloud-key.js usableApiKey)."""
import os
import unittest
from unittest import mock

from zn_gate import client

GOOD = "zn_" + "a" * 20
BAD_KEYS = ("short", "zn_" + "a" * 5, "${user_config.api_key}", "%ZN_API_KEY%", "   ", "a" * 257, "zn_key with space and more")


class TestMalformedKeyCloudOff(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY"):
            os.environ.pop(name, None)

    def test_malformed_argument_key_is_cloud_off(self):
        os.environ["ZN_CLOUD"] = "1"
        for bad in BAD_KEYS:
            self.assertFalse(client.is_cloud_enabled(bad), bad)

    def test_malformed_env_key_is_cloud_off(self):
        os.environ["ZN_CLOUD"] = "1"
        for bad in BAD_KEYS:
            os.environ["ZN_API_KEY"] = bad
            self.assertFalse(client.is_cloud_enabled(), bad)

    def test_malformed_argument_does_not_fall_back_to_env_key(self):
        os.environ.update(ZN_CLOUD="1", ZN_API_KEY=GOOD)
        self.assertFalse(client.is_cloud_enabled("short"))

    def test_valid_key_unchanged(self):
        os.environ["ZN_CLOUD"] = "1"
        self.assertTrue(client.is_cloud_enabled(GOOD))
        self.assertTrue(client.is_cloud_enabled("  " + GOOD + "  "))
        os.environ["ZN_API_KEY"] = GOOD
        self.assertTrue(client.is_cloud_enabled())

    def test_opt_in_still_required(self):
        self.assertFalse(client.is_cloud_enabled(GOOD))
        os.environ["ZN_API_KEY"] = GOOD
        self.assertFalse(client.is_cloud_enabled())
        os.environ["ZN_CLOUD"] = "1"
        self.assertFalse(client.is_cloud_enabled(GOOD, local_only=True))

    def test_analyze_with_malformed_key_stays_local_without_error(self):
        os.environ["ZN_CLOUD"] = "1"
        with mock.patch.object(client, "analyze_cloud", side_effect=AssertionError("cloud must not be called")):
            res = client.analyze("hello there", api_key="short")
        self.assertEqual(res["mode"], "oss-local")
        self.assertEqual(res["engine"], "oss-local")
        self.assertNotIn("cloud_error", res)

    def test_status_says_malformed_key_is_unused(self):
        import io
        from contextlib import redirect_stdout
        from zn_gate import cli
        os.environ.update(ZN_CLOUD="1", ZN_API_KEY="short")
        buf = io.StringIO()
        with redirect_stdout(buf):
            cli.cmd_status(mock.Mock())
        out = buf.getvalue()
        self.assertIn("Local rules only", out)
        self.assertIn("not a valid key", out)
        self.assertIn("Nothing", out)


    def test_status_with_good_key_says_cloud_on(self):
        import io
        from contextlib import redirect_stdout
        from zn_gate import cli
        os.environ.update(ZN_CLOUD="1", ZN_API_KEY=GOOD)
        buf = io.StringIO()
        with redirect_stdout(buf):
            cli.cmd_status(mock.Mock())
        out = buf.getvalue()
        self.assertIn("Local rules + cloud", out)
        self.assertIn("API key         : Set", out)
        self.assertNotIn("not a valid key", out)
        self.assertNotIn(GOOD, out)


if __name__ == "__main__":
    unittest.main()
