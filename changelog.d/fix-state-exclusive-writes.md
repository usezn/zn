### Fixed
- Local state files the CLI writes (the audit baseline, the team notice, the package lookup cache, the usage statistics, the team policy and the upload state) are now written in one step through the exclusive writer: the temporary file gets an unpredictable name, is created only if absent, and is removed when a write fails.
