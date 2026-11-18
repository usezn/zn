### Fixed
- The Python `zn-gate` no longer ends with a traceback when `stats.json` or the evidence log holds JSON nested too deeply to parse. The stats file is treated as unreadable, as the Node CLI already does, and a damaged evidence log is reported as damaged.
