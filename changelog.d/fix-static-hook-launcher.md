### Security
- On Linux, a user install for Claude Code, GitHub Copilot CLI, ZCode and Antigravity now starts the hook through a small
  statically linked launcher. `LD_TRACE_LOADED_OBJECTS` or `LD_DEBUG=help` in the agent's environment made the dynamic loader
  exit before the hook ran, so the call went ahead unchecked. The launcher runs before any loader, denies the call in the
  agent's own format when such a variable or a preload variable is set, and removes every loader variable before it starts
  the hook. Without a matching launcher for the machine, the install keeps the earlier hook and says so. Codex CLI, Gemini CLI,
  Cursor and project installs are not covered (see the threat model).
