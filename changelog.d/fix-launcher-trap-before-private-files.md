### Fixed
- On macOS and Linux, the hook launcher now sets its stop-signal handling before it creates its private temporary files. A TERM, HUP or INT arriving in that first instant could leave those files behind and end the launcher without the block answer.
