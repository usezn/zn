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
