### Security
- PowerShell reads of protected files written with backslash paths are now checked like the same reads through Bash, and a path split across the operands of `Join-Path` is judged as a whole.
- On Windows, a lone `Write-Output`, `echo` or `Write-Host` of a literal backslash path such as `.\.env` is now allowed in the PowerShell tool, because it only prints the text (before, it was refused); the same command in a pipeline, chain, redirect or expansion keeps the read check.
