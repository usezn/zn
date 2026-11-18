### Fixed
- Python: `zn-gate evidence --verify` accepts a ledger line that writes a whole number with a fraction (`latency_us` 5.0 for 5), as the Node package already did. Every whole number is compared by its value, not its spelling, and a boolean is no longer taken for 1 in `confidence`. A changed value still fails the check.
