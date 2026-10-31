### Fixed
- On Windows, a folder path of 260 characters or more is now reported as too long, with the next step (move the folder to a shorter path), instead of "does not exist".
- `zn-gate init --wrap-mcp` says "Cannot be read" for an agent folder you are not allowed to open, instead of "Not installed/configured".
- `zn hooks install claude-code` stops with a next step when the settings file is a link to a file that does not exist, instead of replacing the link and saying "Installed".
- The guided setup no longer says "no internet connection" on its own when npm cannot reach the registry (it can be a VPN, a proxy or a company registry), and the install question now shows the exact command it runs.
