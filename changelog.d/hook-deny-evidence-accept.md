### Security
- The hooks now also refuse `zn-gate evidence --accept` and `zn vault verify --acknowledge` when a coding agent runs them, as they already do for the other commands that only the user may run. Reading the evidence log (`--verify`, `--export`) and `zn vault verify` without `--acknowledge` stay allowed.
