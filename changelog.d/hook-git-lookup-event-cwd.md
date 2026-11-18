### Fixed
- The hook looks up `git` with the event folder, so a `git` in an absolute PATH entry inside the project is never run, even when the hook process itself starts outside the project.
