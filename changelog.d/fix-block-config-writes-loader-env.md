### Security
- The zn hooks now refuse a file write or shell command from the agent that would set `LD_TRACE_LOADED_OBJECTS`, or
  `LD_DEBUG` with `help`, for the agent in a project `.env` or `.gemini/.env` (Write, Edit, patches and `echo`, `printf`,
  `tee`, `sed -i` and similar). On Linux these variables stop every hook before it runs, so the edit is refused while the
  hooks still work. `zn audit` and the hooks share one test for which settings count.
