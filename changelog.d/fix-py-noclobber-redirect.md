### Security
- A download written with the noclobber override is now found in the Python package as well as the Node package: `curl URL >| ~/.bashrc` (and `1>|`, `2>|`, `>|~/.profile`) is blocked as a startup-file write, as `curl URL > ~/.bashrc` already was.
