### Fixed
- Python: the CLI no longer crashes when its output is redirected to a file on Windows (for example `zn-gate scan . > report.txt`) and the report has a character the console code page cannot show. Such characters are now replaced.
