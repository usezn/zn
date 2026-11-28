### Fixed
- A download into more shell startup files is now refused like one into `~/.bashrc`: `~/.inputrc`, `~/.pam_environment`, the fish `config.fish` and `conf.d/*.fish` files, `environment.d/*.conf`, `/etc/bash_profile`, `/etc/csh.cshrc`, `/etc/bash.bash_logout` and `/etc/ssh/sshrc`. The hook and the Node.js and Python libraries give the same verdict.
