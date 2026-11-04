### Security
- The destructive-command policy (Node.js and Python) now reads a command that comes after a shell keyword or a block opener (`if`, `then`, `else`, `elif`, `while`, `until`, `do`, `{` and a leading `!`). Before, a recursive delete of the home folder or the root written inside an if block, a loop or a brace group was allowed; it is now blocked like the same command on its own.
