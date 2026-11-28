### Fixed
- On Windows, `evidence pack` with an evidence log path that is a folder wrote a pack that said "0 records, chain VERIFIED" instead of stopping with a read error. It now stops with "Cannot read the evidence log: EISDIR" and says the folder was not written, as on other systems.
