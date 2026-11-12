### Security
- PowerShell reads of protected files written with backslash paths are now checked like the same reads through Bash, and a path split across the operands of `Join-Path` is judged as a whole.
- A PowerShell command with more than 32 different `Join-Path` calls, or one whose joined path is over 4096 characters, is now refused instead of being checked in part.
