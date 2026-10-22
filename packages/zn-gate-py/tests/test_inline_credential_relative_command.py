"""Inline credential assignment before a command, relative paths included.

Same cases as packages/zn-gate/test/inline_credential_relative_command.test.js.
"""

import unittest

from zn_gate.rules import redact_secrets

# Fictitious value: machine-looking, not a real credential.
V = "Zq8vK2mXp9Lw4Rt7"
R = "[REDACTED_SECRET]"


class InlineCredentialRelativeCommandTests(unittest.TestCase):
    def test_redacted_before_any_command(self):
        commands = ["npm test", "node app.js", "./run", "../bin/run", "./scripts/x.sh", "~/bin/run", "/usr/local/bin/run"]
        for name in ["password", "PASSWORD", "secret", "token", "Passphrase"]:
            for cmd in commands:
                out, detections = redact_secrets(f"{name}={V} {cmd}")
                self.assertEqual(out, f"{name}={R} {cmd}", f"{name} before {cmd}")
                self.assertEqual(detections[0]["rule"], "secret:inline_credential")

    def test_redacted_after_other_assignments_or_env(self):
        self.assertEqual(redact_secrets(f"env FOO=bar password={V} ./run --flag")[0], f"env FOO=bar password={R} ./run --flag")
        self.assertEqual(redact_secrets(f"A=1 B=2 token={V} ../bin/run")[0], f"A=1 B=2 token={R} ../bin/run")

    def test_non_secret_names_and_arguments_untouched(self):
        for s in [
            f"a={V} ./run",
            f"name={V} ../bin/run",
            f"./run password={V}",
            f"./run --opt password={V}",
            f"password={V}",
            "password=changeme-please ./run",
            "password=short ./run",
            "password=$PASSWORD_FROM_ENV ./run",
        ]:
            self.assertEqual(redact_secrets(s)[0], s, s)


if __name__ == "__main__":
    unittest.main()
