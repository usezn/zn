### Fixed
- `zn-gate shield` no longer writes one stderr line and one audit event for every text item of a tool result. The items share the per-message log limit of blocked server text (first 50 logged one by one, the rest in one summary line and one event), so a result with thousands of items cannot stall the proxy on log writes. Every item is still checked.
