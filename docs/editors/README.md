# Editors and coding agents

How much zn-gate can protect in each editor and coding agent, and the two-minute setup for each one.

zn-gate protects most where an agent lets it hook into its own tools: there it can block reads of secret files and remove secrets from what the model sees. Where an editor only supports MCP servers, zn-gate offers its checks to the agent and can check your other MCP servers, but it cannot see the agent's own file reads or shell commands.

| Editor or agent | Setup | Blocks reads of `.env` and credential files | Removes secrets from shell output and files | Removes secrets from MCP results | Blocks a secret pasted into the chat | Tested by us |
| - | - | - | - | - | - | - |
| Claude Code | `zn hooks install claude-code` | Yes | Yes | Yes | Yes | Yes, end to end |
| Codex CLI | `zn hooks install codex`, then trust it in `/hooks` | Yes | Yes (replaces the result) | Yes | Yes | Yes, end to end |
| OpenCode | `zn hooks install opencode` | Yes | Yes | Yes | Yes | Yes, end to end |
| [Cursor](cursor.md) | `zn hooks install cursor` | Yes | **No** (Cursor does not allow it) | Yes | Yes | Formats checked; no end-to-end run |
| [VS Code (GitHub Copilot)](vscode.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Google Antigravity](antigravity.md) | `zn hooks install antigravity` | Yes | **No** (Antigravity hooks cannot rewrite output) | Only servers you wrap | No | Formats checked; hand-tested on Windows; no automated end-to-end run |
| [ZCode desktop app](zcode.md) | `zn hooks install zcode` | Yes | **No** (ZCode hooks cannot rewrite tool output; zn adds a notice) | Only servers you wrap | Yes (blocked, not cleaned) | Tested end to end on the official ZCode desktop app 3.16.3 on Linux x64 (October 2026). The same checks passed on Windows x64 (Windows Server 2022, same app version), for an administrator and for a standard user, through the agent the app ships; the Windows app window itself was not driven. macOS was not tested. |
| [Windsurf (Devin Desktop)](windsurf.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Cline](cline.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Zed](zed.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [JetBrains AI Assistant](jetbrains.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Continue](continue.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |

"Only servers you wrap" means that the results of the MCP servers you start through `zn-gate shield` are checked; each page shows how. The hooks need zn-gate 1.5 or later from npm (`npm install -g zn-gate`). Per-agent details for the hooks: [compat.md](../compat.md).

## Experimental hooks

Gemini CLI and GitHub Copilot CLI have experimental hook adapters in zn-gate 1.14.0. They are listed apart from the six supported agents above and are less tested. Each one blocks reads and writes of secret files by path and shell commands that handle secrets, and stops the agent from editing its own hook or settings files.

Google replaced Gemini CLI with Antigravity CLI for free and Google One accounts on June 18, 2026. Gemini CLI stays supported in zn-gate.

| Agent | Setup | What it does not do |
| - | - | - |
| Gemini CLI | `zn hooks install gemini` | Does not change what a tool returns. Its hooks cannot ask for confirmation, so zn blocks what it would ask about and says why, and a hook that crashes or times out does not block the call. Checked end to end with Gemini CLI 0.64.0. |
| GitHub Copilot CLI | `zn hooks install copilot` | Also replaces secret values in the results of read and shell tools. Cannot block a typed prompt, a call goes through when a hook times out, and not tested on Windows. Checked end to end with Copilot CLI 1.0.98. |

Details: [compat.md](../compat.md) (Gemini CLI and Copilot CLI) and [threat-model.md](../threat-model.md) (these two and Antigravity).

VS Code and Windsurf have their own agent hooks, but zn-gate does not install hooks for them yet. For what Antigravity's hooks cover and what they do not, see [its page](antigravity.md); for ZCode, see [its page](zcode.md).
