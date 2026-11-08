"""zn-gate scan reports a Twilio-style API key on a tab-indented line.

The reported line is the right one and the key value is never printed. The key is invented
(SK + 32 hex characters, a visibly sequential value).
"""

import argparse
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan

FAKE_TWILIO = "SK" + "0123456789abcdef" + "0123456789abcdef"


class TestTwilioKeyTabIndent(unittest.TestCase):
    def test_tab_indented_key_is_found_on_its_line_and_not_printed(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "settings.py"), "w", encoding="utf-8") as f:
                f.write("CONFIG = {\n\t\t\"twilio_api_key\": \"" + FAKE_TWILIO + "\",\n}\n")
            buf = io.StringIO()
            with redirect_stdout(buf):
                cmd_scan(argparse.Namespace(path=d, exclude=None, include=None, format="json", no_fail=True))
            out = buf.getvalue()
            self.assertNotIn(FAKE_TWILIO, out)
            self.assertNotIn("0123456789abcdef", out)
            report = json.loads(out)
            hits = [v for v in report["threats"] if "twilio" in str(v.get("rule", "")).lower()]
            self.assertEqual(len(hits), 1, out)
            self.assertEqual(hits[0]["line"], 2)
            self.assertEqual(hits[0]["type"], "secret_leak")
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
