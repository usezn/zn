"""A commit message that mentions rm is quoted text, not a destructive command.

The message text of `git commit -m` is data: words such as `rm -rf /` inside the quotes must not
block the commit. A destructive command chained after the commit still has to be blocked.
"""

import unittest

from zn_gate import check_command


class CommitMessageMentionsRm(unittest.TestCase):
    def test_message_with_rm_word_is_allowed(self):
        self.assertTrue(check_command('git commit -m "rm old files"').allowed)

    def test_message_saying_remove_rm_is_allowed(self):
        self.assertTrue(check_command("git commit -m 'remove rm -rf from the script'").allowed)

    def test_amend_all_message_with_rm_is_allowed(self):
        self.assertTrue(check_command('git commit -am "fix rm -rf / check"').allowed)

    def test_destructive_command_chained_after_commit_is_blocked(self):
        res = check_command("git commit -m x && rm -rf /")
        self.assertFalse(res.allowed)
        self.assertEqual(res.rule, "destructive:rm_root_home")


if __name__ == "__main__":
    unittest.main()
