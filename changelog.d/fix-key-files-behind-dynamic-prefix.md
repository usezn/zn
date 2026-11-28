### Security
- A shell command that reads a private key file (`.pem`, `.key`, `.p8`) through a path the shell builds while the command runs
  (`cat $(pwd)/server.pem`, a backtick prefix, `${HOME%/}/key.p8`, `${HOME/x/y}/...`, an unset variable) is now refused by its
  name, the same way a `.env` file already was. Before, such a command was allowed even when the file held a private key.
  Affected: zn-gate 1.12.0 and later, since the key file rule was added.
