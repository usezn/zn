### Security
- A program found on the `PATH` whose real file is in the `node_modules` folder of your home folder is not started either, also when zn-gate runs in the home folder. The Claude Code installer and uninstaller no longer run a `claude` that links into the project, and real paths are compared in their canonical spelling (letter case on macOS).
