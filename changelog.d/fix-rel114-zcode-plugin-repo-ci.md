### Added
- The plugin repository check (`verify-plugin-repo.js --target zcode`) and the release workflow now cover the ZCode plugin build; the workflow only opens a pull request in the plugin repository when a maintainer starts it by hand.

### Fixed
- The ZCode plugin hook answers within 28 seconds even if Node.js hangs while it starts: it blocks the call (or only warns on events that cannot block) instead of running into ZCode's 30-second hook timeout.
