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
- Edits to a watched `.env` file by the agent's own file tools are judged on the file they would leave: zn applies the edit or
  patch to the file on disk, and refuses the write when it cannot work out the result.
- Any MCP tool call that names a project `.env` or `.gemini/.env` is refused, whatever the server or the tool is called and even
  with a body (a custom server can call an append or a copy `write_file` or `read_file`): use the agent's own file tools, which
  zn can check. Copies, moves, renames and links through a tool zn does not know are refused too, as zn cannot see the file
  they would leave.
- `git checkout`, `git restore`, `git reset` and `git stash` in a shell command that names a project `.env` are refused: they
  write stored content into the file. `git add`, `git commit` and `git rm --cached` still pass. A tool zn does not know is read
  under any key down to 6 levels of nesting for these files in Claude Code, Gemini CLI, Antigravity, ZCode and Copilot CLI, and a
  call nested deeper, or with more than 500 objects, is refused (all of these agents except OpenCode);
  OpenCode treats such a tool as an MCP call, and Codex CLI and Cursor never send one to the hook.
- A write to a project `.env` or `.gemini/.env` through a tool zn does not know is refused even when the call carries the
  text: such a tool may append or insert it instead of writing the whole file. Only the agents' own whole-file write tools
  and the edits and patches of their own editors, applied by zn to the file on disk, give zn the file a call leaves; no tool
  name from an MCP server is trusted for that.
