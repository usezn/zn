### Fixed
- A new evidence record is written on its own line when the log file does not end with a newline (for example after an edit in an editor). Before, it was appended to the last line and the log could not be verified. A line damaged this way by an earlier version is still reported by `zn-gate evidence --verify`, and writing stops until that file is moved aside, as before.
