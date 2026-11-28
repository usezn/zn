### Security
- The destructive-command check now has tests that pin how ANSI-C quoted words (`$'...'`) are read in both the Node.js and Python packages: in the command name, in arguments and in redirection targets (`dd of=$'/dev/sdz'`, `chmod -R 777 $'\x2f'`, `$'rm' -rf $'/'`). The same commands get the same verdict in both packages, and harmless uses such as `echo $'/tmp/x'` stay allowed.
- An ANSI-C word with a bare `\x`, `\u` or `\U` escape (no hex digit after it) is now kept as bash keeps it. The Python check used to raise an error on such a word instead of giving a verdict.
