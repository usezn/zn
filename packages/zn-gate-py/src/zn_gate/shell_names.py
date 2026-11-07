"""Names of the programs a person types, as they run on this computer."""
import os


def npx_name() -> str:
    """`npx.cmd` on Windows: PowerShell with the default Restricted policy refuses npx.ps1. `npx` elsewhere."""
    return "npx.cmd" if os.name == "nt" else "npx"
