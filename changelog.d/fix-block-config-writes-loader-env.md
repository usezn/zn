### Security
- The zn hooks now refuse a file write or shell command from the agent that would set `LD_TRACE_LOADED_OBJECTS`, or
  `LD_DEBUG` with `help`, for the agent in a project `.env` or `.gemini/.env` (Write, Edit, patches and shell commands).
  On Linux these variables stop every hook before it runs, so the edit is refused while the
  hooks still work. `zn audit` and the hooks share one test for which settings count.
- The same writes are also refused when they set `LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES` or another preload
  variable to a value.
- Shell commands can no longer write a project `.env` or `.gemini/.env`: any shell write to these files is refused, including
  redirections (also `<>`), `tee`, `sed -i`, `cp`, `Set-Content`, and any program that names the file (an interpreter, `awk`,
  `curl -o`) unless it only reads or touches it. zn cannot know what the shell really runs. Use the editor tool instead; zn checks
  what it writes.
- Edits to a watched `.env` file are judged on the file they would leave, in every agent and through MCP servers too: zn
  applies the edit or patch to the file on disk, and refuses the write when it cannot work out the result.
- Copies, moves, renames and links into a project `.env` or `.gemini/.env`, through an MCP server or a tool zn does not know,
  are refused: zn cannot see the file they would leave. Reads of these files are unchanged; use the editor tool to change them.
- `git checkout`, `git restore`, `git reset` and `git stash` in a shell command that names a project `.env` are refused: they
  write stored content into the file. `git add`, `git commit` and `git rm --cached` still pass. A tool zn does not know is read
  under any key and at any depth for these files, and only an exact list of read-only file tools (such as the filesystem
  server's `read_file`) may name them without giving the file they leave.
