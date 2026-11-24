### Security
- On Linux, a user install for ZCode now starts the hook through a small
  statically linked launcher. `LD_TRACE_LOADED_OBJECTS` or `LD_DEBUG=help` in the agent's environment made the dynamic loader
  exit before the hook ran, so the call went ahead unchecked. The launcher runs before any loader, denies the call in the
  agent's own format when such a variable or a preload variable is set, and removes every loader variable before it starts
  the hook. Without a matching launcher for the machine, the install keeps the earlier hook and says so. Codex CLI, Gemini CLI
  and GitHub Copilot CLI are detection only, and so are Claude Code and Antigravity until their launch form is run with the real agent: `zn audit` reports the variables as critical, the hook cannot refuse them, the call goes ahead. Cursor (not verified) and project installs are not covered either
  (see the threat model).
