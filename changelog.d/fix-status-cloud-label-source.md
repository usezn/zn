### Fixed
- `zn-gate status` now names the real source of the cloud check in its "Active Engine" line: `ZN_CLOUD=1` with an API key when that is what turns it on, or the saved `zn-gate connect` marker otherwise. Before, the line always said `ZN_CLOUD=1`, even when only `zn-gate connect` had turned the cloud check on. Which engine is used does not change.
