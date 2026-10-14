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
| [Google Antigravity](antigravity.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Windsurf (Devin Desktop)](windsurf.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Cline](cline.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Zed](zed.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [JetBrains AI Assistant](jetbrains.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Continue](continue.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |

"Only servers you wrap" means that the results of the MCP servers you start through `zn-gate shield` are checked; each page shows how. The hooks need zn-gate 1.5 or later from npm (`npm install -g zn-gate`). Per-agent details for the hooks: [compat.md](../compat.md).

VS Code, Antigravity and Windsurf have their own agent hooks, but zn-gate does not install hooks for them yet.
