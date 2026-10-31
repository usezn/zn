### Fixed
- `zn-gate check` reads the ZCode plugin hooks (a /bin/sh one for macOS and Linux and a PowerShell one for Windows, for every event) for the system it runs on, and no longer reports the plugin as starting the PowerShell program by name. A Windows path such as C:/Windows/... is no longer taken for a program looked up by name, and the hook of the other system is not judged.
