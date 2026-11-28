"""
usable_api_key: the shape check that decides whether a key may be sent to the cloud gate.
It must match the Node.js client (lib/cloud-key.js): 16 to 256 letters, digits, dot, underscore or dash,
after surrounding whitespace is removed. A value that does not pass is never sent anywhere.
Keys here are fake and built at runtime.
"""

import os
import unittest
from unittest import mock

from zn_gate import client

ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE", "ZN_LONG_INPUT", "ZN_VERBOSE", "DEBUG")
ENDPOINT = "https://api.example.test/v30/analyze"
ALLOWED_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"


def _fake(n, ch="k"):
    return ch * n


class TestUsableApiKeyShape(unittest.TestCase):
    def test_empty_and_none_are_refused(self):
        self.assertIsNone(client.usable_api_key(""))
        self.assertIsNone(client.usable_api_key(None))

    def test_non_string_types_are_refused(self):
        for value in (0, 42, 3.5, True, b"k" * 20, ["k" * 20], ("k" * 20,), {"k": "k" * 20}, object()):
            with self.subTest(type=type(value).__name__):
                self.assertIsNone(client.usable_api_key(value))

    def test_whitespace_only_is_refused(self):
        for value in (" ", "   ", "\t", "\n", " \t\r\n ", " " * 300):
            with self.subTest(value=repr(value)[:12]):
                self.assertIsNone(client.usable_api_key(value))

    def test_length_boundaries(self):
        self.assertIsNone(client.usable_api_key(_fake(15)))
        self.assertEqual(client.usable_api_key(_fake(16)), _fake(16))
        self.assertEqual(client.usable_api_key(_fake(256)), _fake(256))
        self.assertIsNone(client.usable_api_key(_fake(257)))

    def test_length_counts_the_stripped_value(self):
        # 15 characters padded with spaces are still 15 characters once trimmed: refused.
        self.assertIsNone(client.usable_api_key("  " + _fake(15) + "  "))
        # 16 characters padded with spaces are accepted, and the result has no padding.
        self.assertEqual(client.usable_api_key("  " + _fake(16) + "\n"), _fake(16))

    def test_every_allowed_character_is_accepted(self):
        value = (ALLOWED_CHARS * 2)[:64]
        self.assertEqual(client.usable_api_key(value), value)

    def test_disallowed_characters_are_refused(self):
        base = _fake(20)
        for bad in (" ", "\t", "\n", "\r", "/", "\\", "+", "=", "$", "{", "}", "%", "!", '"', "'", "`", "#", "@",
                    ":", ";", ",", "*", "&", "?", "<", ">", "|", "~", "^", "(", ")", "[", "]", "\x00", "\x7f",
                    "é", " ", "​", "ａ", "\U0001F511"):
            with self.subTest(char=repr(bad)):
                self.assertIsNone(client.usable_api_key(base + bad + base))

    def test_unexpanded_placeholders_are_refused(self):
        for value in ("${user_config.api_key}", "$ZN_API_KEY", "%ZN_API_KEY%", "{{api_key}}", "<API_KEY_HERE>"):
            with self.subTest(value=value):
                self.assertIsNone(client.usable_api_key(value))

    def test_inner_space_refused_even_when_outer_space_is_trimmed(self):
        self.assertIsNone(client.usable_api_key("  " + _fake(8) + " " + _fake(8) + "  "))

    def test_surrounding_whitespace_is_trimmed(self):
        core = _fake(20)
        for pad in (" ", "\t", "\n", "\r\n", "  \t ", "\x0b", "\x0c", "\xa0"):
            with self.subTest(pad=repr(pad)):
                self.assertEqual(client.usable_api_key(pad + core + pad), core)

    def test_returns_a_str(self):
        self.assertIsInstance(client.usable_api_key(" " + _fake(16) + " "), str)


class TestRejectedKeyNeverSent(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        for name in ZN_VARS:
            os.environ.pop(name, None)

    def tearDown(self):
        self._env.stop()

    def test_analyze_cloud_refuses_before_any_request(self):
        bad = ["", " ", None, _fake(15), _fake(257), "has space" + _fake(16), "${user_config.api_key}", 12345678901234567]
        for key in bad:
            with self.subTest(key=repr(key)[:20]):
                opener = mock.Mock()
                with mock.patch.object(client, "_open", opener):
                    with self.assertRaises(ValueError):
                        client.analyze_cloud("hello there", key, ENDPOINT)
                opener.assert_not_called()

    def test_analyze_falls_back_to_local_without_sending_bad_keys(self):
        os.environ["ZN_CLOUD"] = "1"
        for key in (" ", _fake(15), _fake(257), "${user_config.api_key}", "bad key with spaces 0000"):
            with self.subTest(key=repr(key)[:20]):
                opener = mock.Mock()
                with mock.patch.object(client, "_open", opener):
                    res = client.analyze("hello there", api_key=key, endpoint=ENDPOINT)
                opener.assert_not_called()
                self.assertNotEqual(res.get("mode"), "hybrid-cloud")

    def test_bad_env_key_is_not_sent_by_analyze(self):
        os.environ["ZN_CLOUD"] = "1"
        os.environ["ZN_API_KEY"] = _fake(15)
        opener = mock.Mock()
        with mock.patch.object(client, "_open", opener):
            res = client.analyze("hello there", endpoint=ENDPOINT)
        opener.assert_not_called()
        self.assertNotEqual(res.get("mode"), "hybrid-cloud")

    def test_valid_key_is_sent_trimmed_and_only_once(self):
        key = _fake(16, "z")
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b'{"verdict": "allow"}'
        opener = mock.Mock(return_value=resp)
        with mock.patch.object(client, "_open", opener):
            client.analyze_cloud("hello there", "  " + key + "\n", ENDPOINT)
        self.assertEqual(opener.call_count, 1)
        req = opener.call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), "Bearer " + key)


class TestKnownDifferenceFromNode(unittest.TestCase):
    """Python and Node differ only in what counts as surrounding whitespace. Both refuse an unusable value."""

    def test_byte_order_mark_around_key_is_refused_by_python(self):
        # Node's trim() removes U+FEFF and accepts the key; Python's str.strip() does not, so the key is refused.
        # Refusing is the safe side: the request is not sent and the local rules decide.
        self.assertIsNone(client.usable_api_key("﻿" + _fake(20) + "﻿"))

    def test_information_separators_are_trimmed_by_python_only(self):
        # Python's str.strip() removes U+001C..U+001F; Node's trim() does not, so Node refuses this value.
        # The Python result is an accepted key, not a leak: the separators never reach the header.
        core = _fake(20)
        self.assertEqual(client.usable_api_key("\x1c" + core + "\x1f"), core)


if __name__ == "__main__":
    unittest.main()
