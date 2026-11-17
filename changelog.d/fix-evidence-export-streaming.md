### Fixed
- `zn-gate evidence --export` of a large log (over about 512 MB) no longer writes an empty file and reports it as valid. The export
  now reads the log in parts, so every record is exported in bounded memory, and the dashboard export does the same. If the log
  cannot be read to the end, the export says so and exits 1; an export whose chain does not verify also exits 1.
