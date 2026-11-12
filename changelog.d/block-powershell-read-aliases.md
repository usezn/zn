### Security
- PowerShell reads of protected files written with backslash paths are now checked like the same reads through Bash, and a path split across the operands of `Join-Path` is judged as a whole.
- A PowerShell command whose `Join-Path` calls produce more than 32 different joined paths, or a joined path over 4096 characters, is refused.
