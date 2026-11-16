"""Names of the programs a person types, as they run on this computer."""
import os


def npx_name() -> str:
    """`npx.cmd` on Windows: PowerShell with the default Restricted policy refuses npx.ps1. `npx` elsewhere."""
    return "npx.cmd" if os.name == "nt" else "npx"


def zn_name() -> str:
    """`zn.cmd` on Windows (PowerShell refuses the zn.ps1 shim), `zn` elsewhere."""
    return "zn.cmd" if os.name == "nt" else "zn"


def zn_gate_name() -> str:
    """`zn-gate.cmd` on Windows: PowerShell with the default Restricted policy refuses the zn-gate.ps1 shim that
    npm install -g creates. `zn-gate` elsewhere."""
    return "zn-gate.cmd" if os.name == "nt" else "zn-gate"
