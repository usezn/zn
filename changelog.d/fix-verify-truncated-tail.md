### Fixed
- `zn-gate evidence --verify` now says when the last record of the ledger was cut off (for example by a crash or a full disk) instead of reporting tampering. The ledger still counts as not verified, and the output explains how to start a new log. A record changed in the middle of the ledger is still reported as tampering.
