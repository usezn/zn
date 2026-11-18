### Changed

- Command output and the evidence dashboard call the hash-chained record of decisions the evidence log, as the docs do: `zn-gate evidence --verify` prints "Cryptographic Evidence Log Verification" with a "Log Path" line, and the stats say "zn Evidence Log Stats" (the Python package matches, and its `evidence` help line now says what the command does). File names, flags and API names are unchanged.
