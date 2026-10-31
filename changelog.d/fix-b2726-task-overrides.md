### Fixed
- Copilot and VS Code tasks started with create_and_run_task are now checked in every platform override (linux, osx, windows) as well as the base task, and the strictest verdict wins. A task that sets a custom options.shell is judged like a shell task. Overrides, options or shell settings in a shape zn cannot read are blocked instead of passing.
