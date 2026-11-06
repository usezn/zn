### Fixed
- When the local stats file cannot be read (for example after a crash while it was being written), zn-gate now keeps a copy as stats.damaged.json in the zn folder before it starts a new one, instead of discarding the counts without a trace.
