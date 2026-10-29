"""_prune_info decides whether a directory name is skipped, and how it is reported."""
import os
import tempfile
import unittest

from zn_gate.cli import _prune_info


class PruneInfoTests(unittest.TestCase):
    def test_silent_name_is_skipped_without_report(self):
        with tempfile.TemporaryDirectory() as parent:
            self.assertEqual(
                _prune_info("node_modules", parent),
                {"silent": True, "reason": "skipped by name"},
            )

    def test_marker_name_with_marker_is_reported_with_reason(self):
        with tempfile.TemporaryDirectory() as parent:
            open(os.path.join(parent, "Cargo.toml"), "w").close()
            self.assertEqual(
                _prune_info("target", parent),
                {"silent": False, "reason": "skipped by name: build output next to Cargo.toml"},
            )

    def test_marker_name_without_marker_is_read(self):
        with tempfile.TemporaryDirectory() as parent:
            self.assertIsNone(_prune_info("target", parent))

    def test_unknown_name_falls_back_to_build_output_reason(self):
        # The caller only asks about names in the skip set; for any other name
        # the function reports it as build output.
        with tempfile.TemporaryDirectory() as parent:
            self.assertEqual(
                _prune_info("src", parent),
                {"silent": False, "reason": "skipped by name: build output"},
            )


if __name__ == "__main__":
    unittest.main()
