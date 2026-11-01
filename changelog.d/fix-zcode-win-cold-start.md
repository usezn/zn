### Fixed
- The Windows hook of the ZCode plugin counts its start deadline from the start of the PowerShell process, so a slow first start blocks the call instead of running into ZCode's 30-second hook timeout (which lets the call run). It also takes Node.js only when the program prints a Node.js version of 20.19 or later, not when it merely exits with code 0.
