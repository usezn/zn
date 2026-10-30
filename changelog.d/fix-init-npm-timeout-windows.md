### Fixed
- Windows: when the npm install step of guided `zn-gate init` runs out of time, npm itself is now stopped.
  Before, only the `cmd.exe` that started it was stopped, and npm could go on installing and printing after zn-gate had
  already said it did not finish.
