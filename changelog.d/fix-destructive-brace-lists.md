### Security
- Destructive-command rules, Node.js and Python: a brace list in the downloader, the shell or the startup file (`c{u,}rl ... | sh`, `curl ... | s{h,}`, `curl ... >> ~/.{bashrc,zshrc}`) is now expanded before the download rules are checked; before, these forms were allowed.
