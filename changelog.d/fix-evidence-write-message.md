### Fixed
- When the evidence log cannot be written, the warning now says why in plain words (no permission, the disk is full, a file where a folder should be...) instead of a raw code such as `EACCES`, says that zn still checks the agent's actions but is not recording them, and tells you to fix it and run `zn-gate check`.
