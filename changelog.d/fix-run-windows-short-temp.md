### Fixed
- On Windows, `zn run` now refuses an allowed command that resolves to a file in the temp folder also when the temp folder is set with a short 8.3 name (for example `C:\Users\LONGNA~1\AppData\Local\Temp`) and the file is reached through its long name. Before, such a file was not seen as inside the temp folder and could run with the secret.
