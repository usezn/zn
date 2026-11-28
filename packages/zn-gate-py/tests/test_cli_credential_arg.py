"""secret:cli_credential_arg: the secret of a command line is redacted exactly as the Node.js package does.

Both suites read packages/zn-gate/test/fixtures/cli_credential_arg_cases.json (texts with invented credentials and
the output of redact_secrets / redactSecrets). Skipped when the monorepo checkout is not next to this package.
"""

import json
import unittest
from pathlib import Path

from zn_gate import rules as R

from ._timing import assert_linear

FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "cli_credential_arg_cases.json"


class CliCredentialArgTests(unittest.TestCase):
    def test_fixture_cases(self):
        if not FIXTURE.is_file():
            self.skipTest("packages/zn-gate is not next to this package")
        cases = json.loads(FIXTURE.read_text(encoding="utf8"))["cases"]
        self.assertGreater(len(cases), 30)
        for c in cases:
            sanitized, detections = R.redact_secrets(c["text"])
            self.assertEqual(sanitized, c["sanitized"], c["text"])
            # --api_key=X is already caught by secret:env_credential, which runs first
            self.assertEqual(len(detections) > 0, c["sanitized"] != c["text"], c["text"])

    def test_idempotent(self):
        once, _ = R.redact_secrets("curl -u admin:Zq7!mK2xP9vL https://api.example.com/x")
        self.assertEqual(once, "curl -u admin:[REDACTED_SECRET] https://api.example.com/x")
        self.assertEqual(R.redact_secrets(once)[0], once)

    def test_p_only_after_mysql(self):
        for cmd in ("ssh -pZq7mK2xP9vL host.example.com", "tar -pZq7mK2xP9vL a.tar", "docker run -pZq7mK2xP9vL:80 x"):
            self.assertEqual(R.redact_secrets(cmd)[0], cmd)
        self.assertEqual(R.redact_secrets("mysql -h db.example.com -pZq7mK2xP9vL")[0], "mysql -h db.example.com -p[REDACTED_SECRET]")

    def test_user_pass_only_after_curl(self):
        for cmd in ("docker run -u app:Zq7mK2xP9vL img", "ssh -u app:Zq7mK2xP9vL host", "chown -R user:group dir"):
            self.assertEqual(R.redact_secrets(cmd)[0], cmd)

    def test_linear(self):
        builders = {
            "curl -u": lambda k: "curl " + "-u " * k,
            "curl then words": lambda k: "curl " + "x " * k + "-u a:",
            "mysql -p": lambda k: "mysql " + "-p " * k,
            "mysql then words": lambda k: "mysql " + "x " * k + "-p",
            "spaces after a flag": lambda k: "--password " + " " * (4 * k) + "x",
            "repeated flag": lambda k: "--token=" * k,
            "repeated PGPASSWORD": lambda k: "PGPASSWORD=" * k,
            "long curl lines": lambda k: ("curl " + "a" * 250 + " ") * (k // 25),
        }
        for label, build in builders.items():
            assert_linear(R.redact_secrets, build, 40000, label)


if __name__ == "__main__":
    unittest.main()
