### Security
- Windows: a protected file named with an 8.3 short name behind a namespace or device prefix (`\\?\`, `\\.\`, `//?/`) or an admin share (`\\localhost\C$\`, `\\?\UNC\localhost\C$\`) is now refused by shell commands such as `type` and by file reads. The prefix is replaced by the drive before the path is checked.
