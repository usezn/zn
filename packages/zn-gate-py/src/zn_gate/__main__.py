"""Run the zn-gate CLI with ``python -m zn_gate``.

This works even when the ``zn-gate`` script is not on PATH (for example on
Windows, where pip puts it in a Scripts folder that is often not on PATH).
"""

import sys

from zn_gate.cli import main

if __name__ == "__main__":
    sys.exit(main())
