### Fixed
- A long command made of redirection characters, such as a 100 KiB run of digits and `<` or `>`, no longer slows the command check to the hook timeout. The Node and Python packages now read file-descriptor redirections like `2>&1` in a single pass, with the same results as before.
