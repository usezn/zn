### Security
- The zn hooks now refuse a file write or shell command from the agent that would set `LD_TRACE_LOADED_OBJECTS`, or
  `LD_DEBUG` with `help`, for the agent in a project `.env` or `.gemini/.env` (Write, Edit, patches and `echo`, `printf`,
  `tee`, `sed -i` and similar). On Linux these variables stop every hook before it runs, so the edit is refused while the
  hooks still work. `zn audit` and the hooks share one test for which settings count.
- The same writes are also refused when they set `LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES` or another preload
  variable to a value. A shell command that writes such a file is refused when a variable name or a whole line it writes
  comes from a variable, a command substitution or a pattern (`printf "$X" > .env`); `echo "API_URL=$URL" >> .env` still works.
