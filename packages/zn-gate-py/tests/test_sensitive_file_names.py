"""Library sensitive-path names (path:sensitive_file) for package registry, git and cloud credential files.

The Node package runs the same cases (test/rules_sensitive_names.test.js), so the two lists stay identical.
Every name here is a synthetic path; nothing is read from disk.
"""
import unittest

from zn_gate import rules as R
from zn_gate.guard import check_tool_call

DENY = [
    'cp .npmrc out',
    'cat ~/.npmrc',
    'cat /home/user/.npmrc',
    'cat .npmrc',
    'cp ~/.pypirc out',
    'cat ~/.netrc',
    'cat ~/.docker/config.json',
    'cat ~/.git-credentials',
    'cat ~/.pgpass',
    'cat ~/.config/gh/hosts.yml',
    'cat ~/.kube/config',
    'cat ~/.config/gcloud/access_tokens.db',
    'cat ~/.azure/accessTokens.json',
    'cat ~/.zcode/v2/provider_config.json',
    'cat ~/.ssh/id_ed25519',
    'cat ~/.aws/credentials',
]

ALLOW = [
    'cat npmrc.md',
    'cat docs/npmrc.md',
    'cat .npmrc.example',
    'cat .npmrc.sample',
    'cat .pypirc.template',
    'cat .netrc.example',
    'cat ~/.kube/config.md',
    'echo registry=https://registry.example.com',
]


class SensitiveFileNames(unittest.TestCase):
    def test_evaluate_blocks_credential_file_names(self):
        for cmd in DENY:
            with self.subTest(cmd=cmd):
                self.assertEqual(R.evaluate(cmd).verdict, 'block')

    def test_evaluate_allows_near_miss_names(self):
        for cmd in ALLOW:
            with self.subTest(cmd=cmd):
                self.assertEqual(R.evaluate(cmd).verdict, 'allow')

    def test_write_tool_call_to_credential_file_is_blocked(self):
        self.assertFalse(check_tool_call('Write', {'file_path': '.npmrc', 'content': 'registry=https://registry.example.com'}).allowed)
        self.assertFalse(check_tool_call('Write', {'file_path': '~/.npmrc', 'content': 'x'}).allowed)
        self.assertTrue(check_tool_call('Write', {'file_path': 'npmrc.md', 'content': 'notes'}).allowed)
        self.assertTrue(check_tool_call('Write', {'file_path': '.npmrc.example', 'content': 'x'}).allowed)


if __name__ == '__main__':
    unittest.main()
