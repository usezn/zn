### Fixed
- When the disk is full, the hooks no longer leave an empty lock file next to the evidence log. It made every following hook call wait half a second and report that another process was writing to the log.
