"""What the folder zn keeps its private state in (~/.zn, or ZN_HOME) supports.

Same probe as the npm package (lib/state-fs.js): FAT, exFAT and some network shares accept chmod and ignore it, and
cannot hold a Unix socket. The folder is probed, not guessed from the file system name: a temporary file is made,
chmod 0600 and read back; a Unix socket is bound in the vault's run folder (or the state folder) and closed. A probe
that cannot run never claims a problem. Nothing is created when the folder does not exist yet. Cached per process.
"""
import errno
import os
import secrets
import socket
import stat
import sys
from typing import Any, Dict, Optional

NO_SOCKET_ERRNOS = frozenset(
    code for code in (
        getattr(errno, "EPERM", None),
        getattr(errno, "ENOTSUP", None),
        getattr(errno, "EOPNOTSUPP", None),
        getattr(errno, "ENOSYS", None),
        getattr(errno, "EAFNOSUPPORT", None),
    ) if code is not None
)
_MAX_SOCKET_PATH = 90

FIX = "Next step: set ZN_HOME to a folder on a disk with Unix permissions, such as your home disk."

_cache: Dict[str, Dict[str, bool]] = {}


class _Layer:
    """The file system calls the probe makes; tests replace them."""

    def is_dir(self, path: str) -> bool:
        return os.path.isdir(path)

    def create(self, path: str) -> None:
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666))

    def chmod(self, path: str, mode: int) -> None:
        os.chmod(path, mode)

    def mode_of(self, path: str) -> int:
        return stat.S_IMODE(os.stat(path).st_mode)

    def unlink(self, path: str) -> None:
        os.unlink(path)

    def bind_socket(self, address: str) -> Optional[int]:
        """None when a socket can be bound, else the errno."""
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.bind(address)
            return None
        except OSError as exc:
            return exc.errno or -1
        finally:
            sock.close()


def _nearest_existing(folder: str, layer: Any) -> str:
    d = os.path.abspath(folder)
    while True:
        if layer.is_dir(d):
            return d
        up = os.path.dirname(d)
        if up == d:
            return d
        d = up


def _probe_name(suffix: str) -> str:
    return ".zn-probe-%d-%s%s" % (os.getpid(), secrets.token_hex(4), suffix)


def _probe_permissions(folder: str, layer: Any) -> bool:
    path = os.path.join(folder, _probe_name(""))
    made = False
    try:
        layer.create(path)
        made = True
        layer.chmod(path, 0o600)
        return (layer.mode_of(path) & 0o077) == 0
    except Exception:
        return True
    finally:
        if made:
            try:
                layer.unlink(path)
            except Exception:
                pass


def _probe_sockets(folder: str, layer: Any) -> bool:
    address = os.path.join(folder, _probe_name(".sock"))
    if len(address) > _MAX_SOCKET_PATH:
        return True
    try:
        code = layer.bind_socket(address)
    except Exception:
        code = None
    try:
        layer.unlink(address)
    except Exception:
        pass
    return not (code is not None and code in NO_SOCKET_ERRNOS)


def support(folder: Optional[str] = None, layer: Any = None) -> Dict[str, Any]:
    """{folder, permissions_enforced, unix_sockets}. A given layer is for tests and is never cached."""
    from .stats import zn_home
    state = os.path.abspath(folder or zn_home())
    if layer is None and (sys.platform == "win32" or not hasattr(socket, "AF_UNIX")):
        return {"folder": state, "permissions_enforced": True, "unix_sockets": True}
    use = layer or _Layer()
    if layer is None and state in _cache:
        return {"folder": state, **_cache[state]}
    base = _nearest_existing(state, use)
    run = os.path.join(state, "run")
    run_base = run if use.is_dir(run) else base
    result = {
        "permissions_enforced": _probe_permissions(base, use),
        "unix_sockets": _probe_sockets(run_base, use),
    }
    if layer is None:
        _cache[state] = result
    return {"folder": state, **result}


def problem_text(info: Dict[str, Any]) -> str:
    """One sentence naming the folder and what it lacks; '' when it supports both. Same words as the npm package."""
    no_perm = info.get("permissions_enforced") is False
    no_sock = info.get("unix_sockets") is False
    if not no_perm and not no_sock:
        return ""
    where = "The folder where zn keeps its private state (%s) " % info.get("folder")
    if no_perm and no_sock:
        return (where + "ignores Unix file permissions and cannot hold Unix sockets (it is probably a FAT, exFAT or network disk), "
                "so the evidence log, stats and vault files stay readable by other users and the vault cannot run there. " + FIX)
    if no_perm:
        return (where + "ignores Unix file permissions (it is probably a FAT, exFAT or network disk), "
                "so the evidence log, stats and vault files stay readable by other users. " + FIX)
    return where + "cannot hold Unix sockets (it is probably a FAT, exFAT or network disk), so the vault cannot run there. " + FIX


def clear_cache() -> None:
    _cache.clear()
