"""The one place that decides which folder zn-gate keeps its state in, and which folder is the user's home.

ZN_HOME wins when it is set to an absolute path. Otherwise the home folder (HOME, or the account's entry in the
password file; USERPROFILE on Windows) must be an absolute path that is not empty and not the root of the disk.
When no usable folder exists nothing is written anywhere: callers get a HomeError that names HOME and ZN_HOME and
says what to set. Nothing here runs when the module loads. The npm package follows the same rule.
"""

import os
from typing import Optional


class HomeError(RuntimeError):
    """No safe folder for zn-gate's state: HOME and ZN_HOME do not name one."""


_HOW_TO_FIX = ("Set ZN_HOME to an absolute folder you can write, for example ZN_HOME=/workspace/.zn "
               "(or set HOME to your home folder).")


def _home_var() -> str:
    return "USERPROFILE" if os.name == "nt" else "HOME"


def _is_root(path: str) -> bool:
    ab = os.path.abspath(path)
    return os.path.dirname(ab) == ab


def account_home() -> str:
    """The user's home folder as a validated absolute path, or a HomeError."""
    var = _home_var()
    raw: Optional[str] = os.environ.get(var) if os.name != "nt" else None
    if raw is None:
        # Not set (or Windows): the system's answer; os.path.expanduser returns "~" unchanged when it has none.
        raw = os.path.expanduser("~")
        if raw == "~" or raw.startswith("~" + os.sep):
            why = f"the system has no home folder for this user ({var} is not set and the user has no entry in /etc/passwd)"
            raise HomeError(f"zn-gate cannot find a safe home folder: {why}, so it did not write anything. {_HOW_TO_FIX}")
    if not raw.strip():
        why = f"{var} is empty"
    elif not os.path.isabs(raw):
        why = f"{var} is a relative path ({raw!r})"
    elif _is_root(raw):
        why = f"{var} is the root folder ({raw!r})"
    else:
        return raw
    raise HomeError(f"zn-gate cannot find a safe home folder: {why}, so it did not write anything. {_HOW_TO_FIX}")


def zn_home() -> str:
    """The state folder: ZN_HOME when set, else <home>/.zn. Raises HomeError when neither is usable."""
    z = os.environ.get("ZN_HOME")
    if z:
        # An explicit ZN_HOME is the user's choice: a relative one is kept and resolved against the current folder.
        return os.path.abspath(z)
    return os.path.join(account_home(), ".zn")
