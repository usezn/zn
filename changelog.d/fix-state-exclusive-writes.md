### Fixed
- State files the CLI writes (the audit baseline, the team notice and the package lookup cache) are now written in one step through the exclusive writer: the temporary file gets an unpredictable name, is created only if it does not exist, and is removed when the write fails.
