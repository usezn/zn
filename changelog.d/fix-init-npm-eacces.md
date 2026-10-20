### Fixed
- `zn-gate init` now explains what to do when `npm install -g` is refused because npm's global folder is not writable (common with Node.js from nodejs.org on macOS or from a Linux distribution). It says which agents stay unprotected, and shows the commands to give npm a folder in your home directory (never `sudo`), then to run `npx -y zn-gate init` again.
