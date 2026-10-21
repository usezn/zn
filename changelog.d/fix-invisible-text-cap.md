### Fixed
- Tool output that is mostly invisible characters, such as a 32 MB result of zero-width spaces, is now blocked in a fraction of a second (rule `size:invisible`) instead of taking about 24 seconds to scan and then passing as clean.
