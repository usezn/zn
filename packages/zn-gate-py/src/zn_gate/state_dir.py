"""zn's state folder (~/.zn, or the folder ZN_HOME names) and its private subfolders.

On POSIX systems a folder owned by this account is tightened to 0700 (group and other access, setgid and sticky are
removed), also when it existed before with a looser mode. A folder owned by someone else, or one that cannot be
tightened, is not used: ensure_state_dir raises StateDirError (an OSError). Windows: nothing is done here.
This is the same rule as lib/state-dir.js in the npm package.
"""
import os
import stat
from typing import List

from .stats import zn_home


class StateDirError(OSError):
    pass


def _posix() -> bool:
    return os.name == "posix" and hasattr(os, "getuid")


def _shown(path: str) -> str:
    home = os.path.expanduser("~")
    p = os.path.abspath(path)
    if home and (p == home or p.startswith(home + os.sep)):
        return "~" + p[len(home):]
    return p


def _error(path: str, why: str) -> StateDirError:
    return StateDirError(
        f"the zn state folder {_shown(path)} {why}, so zn will not use it. "
        f"Next step: run `chmod 700 {_shown(path)}` as its owner, or choose another folder with ZN_HOME."
    )


def _tighten(path: str) -> None:
    try:
        st = os.stat(path)
    except OSError as exc:
        raise _error(path, f"cannot be read ({exc.strerror or 'error'})")
    if not stat.S_ISDIR(st.st_mode):
        raise _error(path, "is not a folder")
    if st.st_uid != os.getuid():
        raise _error(path, "is owned by another user")
    if st.st_mode & 0o7077 == 0:
        return  # owner-only already (a stricter folder, such as 0500, stays as it is)
    try:
        os.chmod(path, st.st_mode & 0o700)
    except OSError as exc:
        raise _error(path, f"is open to other accounts and cannot be restricted ({exc.strerror or 'error'})")
    if os.stat(path).st_mode & 0o7077:
        raise _error(path, "is open to other accounts and cannot be restricted")


def ensure_state_dir(path: str, create: bool = True) -> None:
    """Makes `path` when missing (create=True) and tightens it, with the state folder above it when it lies inside."""
    path = os.path.abspath(path)
    if not _posix():
        if create:
            os.makedirs(path, mode=0o700, exist_ok=True)
        return
    if not create and not os.path.exists(path):
        return
    if create:
        os.makedirs(path, mode=0o700, exist_ok=True)
    chain = [path]
    root = os.path.abspath(zn_home())
    if path != root and path.startswith(root + os.sep):
        chain.append(root)
    for d in chain:
        _tighten(d)


def describe(path: str) -> List[str]:
    """What `check` says about the folder: [] when it is private or absent, else one sentence. Never raises."""
    try:
        if not _posix() or not os.path.exists(path):
            return []
        st = os.stat(path)
        mode = format(stat.S_IMODE(st.st_mode), "04o")
        if st.st_uid != os.getuid():
            return [f"The zn state folder {_shown(path)} is owned by another user (mode {mode}), so zn will not use it. Use another folder with ZN_HOME."]
        if st.st_mode & 0o7077:
            return [f"The zn state folder {_shown(path)} has mode {mode}, which other accounts can use. zn restricts it to 0700 the next time it writes there."]
    except Exception:
        pass
    return []
