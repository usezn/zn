"""GNU find -files0-from FILE (or - for stdin) takes its starting paths from a file the command text does not show; a delete
over them is refused and the file is never read. Mirrors packages/zn-gate/test/destructive_find_files0.test.js. Only example paths."""
import pytest

from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


@pytest.mark.parametrize(
    "cmd",
    [
        "find -files0-from - -delete",
        "find -files0-from list.txt -delete",
        "find -files0-from list.txt -name '*.tmp' -delete",
        "find -files0-from - -type f -name '*.tmp' -delete",
        "find -files0-from list.txt -name '*.tmp' -exec rm {} ;",
        "find -files0-from list.txt -name '*.tmp' -execdir rm {} ;",
        "find -files0-from list.txt -name '*.tmp' -ok rm {} ;",
    ],
)
def test_files0_from_delete_refused(cmd):
    assert rule(cmd) == "rm_root_home"


@pytest.mark.parametrize(
    "cmd",
    [
        "find -files0-from list.txt -name '*.tmp' -print",
        "find -files0-from - -print",
        "find -files0-from list.txt -name '*.tmp' -exec ls {} ;",
        "find ./build -name '*.tmp' -delete",
        "find ./build -type f -print",
    ],
)
def test_files0_from_without_delete_and_plain_find_allowed(cmd):
    assert rule(cmd) == "allow"


def test_filtered_delete_from_root_still_refused():
    assert rule("find / -name '*.tmp' -delete") == "rm_root_home"
