### Fixed
- `zn-gate evidence --export` of a large log (over about 512 MB) no longer writes an empty file and reports it as valid. The export
  now reads the log in parts, so every record is exported in bounded memory, and the dashboard export does the same. In the npm
  package, if the log cannot be read to the end the export says so and exits 1, and an export whose chain does not verify
  also exits 1. The Python package reports a non-verifying export and still exits 0.
- `evidence --export --output` (Node and Python) refuses an output path that is the evidence log itself, or a link or hard
  link to it, and exits 2. Before, the log was emptied and the command could report zero records as valid. Nothing is touched
  when it refuses.
