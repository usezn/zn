### Fixed
- A download into a few more shell and session startup files is now refused like one into `~/.bashrc`: `~/.ssh/rc`, `~/.ssh/environment`, `~/.xprofile`, `~/.xinitrc`, `~/.bash_logout`, `~/.zlogout`, `/etc/zlogin` and the `/etc/zsh/` startup files. The hook and the Node.js and Python libraries give the same verdict.
