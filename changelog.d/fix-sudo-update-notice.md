### Fixed
- After `sudo npm install -g zn-gate` or `sudo npm update -g zn-gate`, the install step now prints one line telling you to run `zn hooks install <agent>` again as yourself. Until you do, the hooks block tool calls with the message that zn-gate changed since the hooks were installed. The upgrade, check and troubleshooting guides now say the same.
