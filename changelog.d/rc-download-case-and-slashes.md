### Security
- A download written to a shell startup file is now refused whatever the case of the file name (`~/.BASHRC`, `~/.Zshrc`,
  `/ETC/profile`: the same file on macOS and Windows) and after repeated slashes or `.` segments are folded
  (`/etc//profile`, `//etc/profile`, `/etc/./profile`). The Node.js and Python engines match the same way.
