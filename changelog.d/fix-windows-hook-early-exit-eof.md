### Fixed
- On Windows, `zn-gate check` and the Antigravity self-check no longer report a hook as "could not be started" when it answered and exited before reading all of its input (Windows reports that write as EOF, not EPIPE).
