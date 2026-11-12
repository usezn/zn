### Fixed
- The destructive-command check no longer looks up a module for every word of a command, which made long command lines tens of times slower on Windows than on Linux.
