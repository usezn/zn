### Changed
- `zn-gate evidence`, `evidence --verify` and `evidence --export` (npm and PyPI packages) read the log once, line by line, instead of loading it whole.
  On a 1 GB log the peak memory drops from several GB to well under 200 MB. The results, the messages and the exit codes are unchanged.
