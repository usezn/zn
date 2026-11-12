### Security
- PowerShell reads of protected files written with backslash paths are now checked like the same reads through Bash, and a path split across the operands of `Join-Path` is judged as a whole.
