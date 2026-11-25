### Security
- The zn hooks now refuse a file write or shell command from the agent that would set `LD_TRACE_LOADED_OBJECTS`, or
  `LD_DEBUG` with `help`, for the agent in a project `.env` or `.gemini/.env` (Write, Edit, patches and shell commands).
  On Linux these variables stop every hook before it runs, so the edit is refused while the
  hooks still work. `zn audit` and the hooks share one test for which settings count.
- The same writes are also refused when they set `LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES` or another preload
  variable to a value.
- A shell command may write a project `.env` or `.gemini/.env` only as literal text: `echo` or `printf` as the first word,
  with no `%`, backslash, `$`, command substitution, glob or prefix in its arguments (`echo API_URL=https://example.com >> .env`),
  or `cat` with a here-document whose delimiter is quoted (`<<'EOF'`). Every other shell write to these files is refused,
  because zn cannot see what it writes, including `echo "API_URL=$URL" >> .env`, `sed -i`, `tee` and copies such as `cp x .env`.
  Use the editor tool instead; zn checks what it writes.
