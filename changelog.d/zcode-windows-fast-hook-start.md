### Fixed
- The ZCode plugin on Windows starts its hook through a small batch file that starts Node.js directly, as 1.15.0 does, instead of starting Windows PowerShell first (which could take longer than ZCode lets a hook run, so the call ran unchecked). ZCode now gives the plugin hooks 5 minutes and the hook stops itself after 2 minutes.
