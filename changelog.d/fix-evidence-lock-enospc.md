### Fixed
- The Python package no longer leaves an empty evidence lock file behind when the disk is full. Before, after space was freed, evidence records were skipped for up to 10 seconds with "another process is writing to the log". The disk error is now reported as before, and the next record is written at once.
