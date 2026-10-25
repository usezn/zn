### Fixed
- On NixOS and Guix the hook launcher's deadline now starts: it finds `sleep` (and `setsid`) in the system profile folders instead of only `/bin`, so strict launchers no longer block every call there.
