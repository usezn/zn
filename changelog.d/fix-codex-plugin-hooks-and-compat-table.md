### Security
- The Codex plugin (`zn-gate` for Codex) now checks the arguments of MCP tool calls and answers Codex's approval prompts, and adds the session, subagent and final-answer events, so it registers the same seven hook events with the same matchers as `zn hooks install codex`. Before, the plugin checked only shell commands and patches before they ran, so a secret value or placeholder in the arguments of an MCP tool call reached the server unchecked. Plugin only: the CLI install was not affected. Release the plugin to get the fix.

### Fixed
- The compatibility table now matches what zn-gate does: Claude Code output is scrubbed for the listed tools only (not Glob, WebSearch or Task), OpenCode and Gemini CLI check MCP tool calls, ZCode's plugin folder is protected, and the Claude Code plugin has a `SessionStart` check.
