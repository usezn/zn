### Changed
- `zn-gate reach --history` is about four times faster in the Python package (a 63 MB history that took 27 seconds now takes about 7), with the same report and the same `--json` output. The npm package is still faster, so on a very large history raise `--max-seconds`.
