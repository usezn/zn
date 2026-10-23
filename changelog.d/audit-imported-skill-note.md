### Fixed
- zn audit no longer lowers the severity of a file that CLAUDE.md or AGENTS.md imports with @path when the same file also sits in a skills folder. An imported file is loaded as instructions, so it is checked in full, whichever way it was found first.
