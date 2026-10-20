"""Environment rules shared by the whole package (kept identical to the npm package)."""

from __future__ import annotations

import os
from typing import Mapping, Optional


def zn_home(env: Optional[Mapping[str, str]] = None) -> str:
    """The folder zn keeps its state in: ZN_HOME when set, else ~/.zn. Evidence, stats and the vault agree."""
    env = os.environ if env is None else env
    home = env.get("ZN_HOME")
    if home:
        return os.path.abspath(home)
    return os.path.join(os.path.expanduser("~"), ".zn")


def is_verbose(env: Optional[Mapping[str, str]] = None) -> bool:
    """One rule for ZN_VERBOSE: on only for 1, true, yes or on (any case, spaces ignored);
    unset, empty, 0, false, no, off and anything else mean off."""
    env = os.environ if env is None else env
    return (env.get("ZN_VERBOSE") or "").strip().lower() in ("1", "true", "yes", "on")


def debug_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """Debug messages are shown when DEBUG is set or ZN_VERBOSE is on."""
    env = os.environ if env is None else env
    return bool(env.get("DEBUG")) or is_verbose(env)
