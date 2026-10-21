"""One rule for "show technical detail", the same as the Node.js package (lib/verbose.js):
ZN_VERBOSE=1, or a DEBUG value that names zn (entries split on commas or spaces: zn, zn*,
zn:*, zn-gate, zn-gate:*). A bare DEBUG=* or DEBUG=express:*, set by other tools, does not
turn it on."""

import os
import re

_ENTRY = re.compile(r"(zn|zn-gate)(\*|:.*)?")


def is_verbose(env=None):
    env = os.environ if env is None else env
    if env.get("ZN_VERBOSE") == "1":
        return True
    debug = env.get("DEBUG") or ""
    return any(_ENTRY.fullmatch(entry) for entry in re.split(r"[\s,]+", debug) if entry)
