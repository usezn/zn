### Changed
- AWS key ids with the `ASIA`, `ABIA` or `ACCA` prefix that end in `EXAMPLE` are now redacted, like `AKIA` ids already were. Python and Node give the same output. A key id is no longer skipped because of how it ends.
