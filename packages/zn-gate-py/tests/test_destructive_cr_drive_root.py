"""A carriage return after a drive root or system folder is still that target (twin of the Node.js test). Strings only."""

import pytest

from zn_gate.destructive import check_command

B = chr(92)
CR = chr(13)


@pytest.mark.parametrize("cmd", [
    "rd /s /q C:" + B + CR,
    "rd /s /q C:" + CR,
    "rd /s /q C:/" + CR,
    "rmdir /s /q C:" + B + CR + CR,
    "rd /s /q C:" + B + CR + "\n",
    "del /f /s /q C:" + B + "*" + CR,
    "rd /s /q C:" + B + "Users" + CR,
    "rd /s /q C:" + B + "Windows" + CR,
    "rm -r" + "f /" + CR,
])
def test_cr_after_root_is_still_rm_root_home(cmd):
    res = check_command(cmd)
    assert not res.allowed and res.rule == "destructive:rm_root_home", repr(cmd)


@pytest.mark.parametrize("cmd", [
    "rd /s /q C:" + B + "build" + CR,
    "rd /s /q C:" + B + "Users" + B + "alice" + B + "proj" + B + "out" + CR,
    "rm -r" + "f /tmp/x" + CR,
    "dir C:" + B + CR,
])
def test_cr_after_other_folder_stays_allowed(cmd):
    assert check_command(cmd).allowed, repr(cmd)
