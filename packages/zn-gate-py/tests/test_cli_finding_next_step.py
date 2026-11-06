"""The next-step sentence for a finding, by kind of file: an env file, a key
file and any other file. The file is shown relative to the current folder, the
value is never printed, and a path on another drive is shown as given."""
import os
import tempfile
import unittest

from zn_gate.cli import _leak_next_step

FAKE_VALUE = "ZNTESTFAKE-not-a-real-value"
ENV_STEP = ("Next: run npx -y zn-gate env shadow {arg} to move the values into the local vault, "
            "and rotate any value that was ever committed or shared.")
KEY_STEP = ("Next: move the key out of this file (for example to ~/.ssh or a secret manager) "
            "and replace it if the file was ever committed or shared.")
OTHER_STEP = ("Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the "
              "__ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.")


class TestFindingNextStep(unittest.TestCase):
    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.realpath(self._tmp.name)
        os.chdir(self.dir)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def test_env_file_is_shown_relative_to_the_current_folder(self):
        for name in (".env", ".env.local"):
            with self.subTest(name=name):
                absolute = os.path.join(self.dir, name)
                self.assertEqual(_leak_next_step(absolute, "secret:aws_access_key"), ENV_STEP.format(arg=name))
                self.assertEqual(_leak_next_step(name, "secret:aws_access_key"), ENV_STEP.format(arg=name))

    def test_env_file_in_a_subfolder(self):
        absolute = os.path.join(self.dir, "app", ".env.local")
        self.assertEqual(_leak_next_step(absolute, "secret:generic"), ENV_STEP.format(arg="app/.env.local"))

    def test_upper_case_env_prefix_is_an_env_file(self):
        self.assertEqual(_leak_next_step(".ENV", "secret:generic"), ENV_STEP.format(arg=".ENV"))

    def test_file_named_env_txt_gets_the_general_sentence(self):
        for name in ("ENV.TXT", os.path.join(self.dir, "ENV.TXT")):
            with self.subTest(name=name):
                self.assertEqual(_leak_next_step(name, "secret:generic"), OTHER_STEP)

    def test_key_file_gets_the_key_sentence_whatever_its_name(self):
        for name in ("id_rsa", ".env", os.path.join(self.dir, "server.pem")):
            with self.subTest(name=name):
                self.assertEqual(_leak_next_step(name, "secret:private_key"), KEY_STEP)

    def test_any_other_file_gets_the_general_sentence(self):
        for name in ("config.yaml", os.path.join(self.dir, "src", "settings.py"), "notes.env.txt"):
            with self.subTest(name=name):
                self.assertEqual(_leak_next_step(name, "secret:aws_access_key"), OTHER_STEP)

    def test_value_is_never_printed(self):
        # The value is not an input at all; a value in the file name is only
        # shown when it is made of plain characters, never anything else.
        for name, rule in ((".env", "secret:generic"), ("a.txt", "secret:generic"), ("k", "secret:private_key")):
            with self.subTest(name=name):
                self.assertNotIn(FAKE_VALUE, _leak_next_step(name, rule))

    def test_file_outside_the_current_folder_is_shown_with_dots(self):
        sub = os.path.join(self.dir, "inner")
        os.mkdir(sub)
        os.chdir(sub)
        step = _leak_next_step(os.path.join(self.dir, ".env"), "secret:generic")
        self.assertEqual(step, ENV_STEP.format(arg="../.env"))

    @unittest.skipUnless(os.name == "nt", "another drive exists only on Windows")
    def test_path_on_another_drive_is_shown_as_given(self):
        cwd_drive = os.path.splitdrive(os.getcwd())[0].upper()
        other = "D:" if cwd_drive != "D:" else "E:"
        given = other + "\\project\\.env"
        step = _leak_next_step(given, "secret:generic")
        self.assertEqual(step, ENV_STEP.format(arg="<file>"))
        self.assertNotIn(FAKE_VALUE, step)


if __name__ == "__main__":
    unittest.main()
