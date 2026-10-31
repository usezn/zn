# Editors and coding agents

How much zn-gate can protect in each editor and coding agent, and the two-minute setup for each one.

zn-gate protects most where an agent lets it hook into its own tools: there it can block reads of secret files and remove secrets from what the model sees. Where an editor only supports MCP servers, zn-gate offers its checks to the agent and can check your other MCP servers, but it cannot see the agent's own file reads or shell commands.

| Editor or agent | Setup | Blocks reads of `.env` and credential files | Removes secrets from shell output and files | Removes secrets from MCP results | Blocks a secret pasted into the chat | Tested by us |
| - | - | - | - | - | - | - |
| Claude Code | `zn hooks install claude-code` | Yes | Yes | Yes | Yes | Yes, end to end |
| Codex CLI | `zn hooks install codex`, then trust it in `/hooks` | Yes | Yes (replaces the result) | Yes | Yes | Yes, end to end |
| OpenCode | `zn hooks install opencode` | Yes | Yes | Yes | Yes | Yes, end to end |
| [Cursor](cursor.md) | `zn hooks install cursor` | Yes | **No** (Cursor does not allow it) | Yes | Yes | Formats checked; no end-to-end run |
| [GitHub Copilot (VS Code, CLI)](vscode.md) | `zn hooks install copilot` | Yes | Yes (read-type and shell tools) | Only servers you wrap | No | Documented for VS Code, not tested in the app; run end to end with Copilot CLI 1.0.98 |
| [Google Antigravity](antigravity.md) | `zn hooks install antigravity` | Yes | **No** (Antigravity hooks cannot rewrite output) | Only servers you wrap | No | Formats checked; hand-tested on Windows; no automated end-to-end run |
| [ZCode desktop app](zcode.md) | `zn hooks install zcode` | Yes | **No** (ZCode hooks cannot rewrite tool output; zn adds a notice) | Only servers you wrap | Yes (blocked, not cleaned) | Tested end to end on the official ZCode desktop app 3.16.3 on Linux x64 (October 2026). The same checks passed on Windows x64 (Windows Server 2022, same app version), for an administrator and for a standard user, through the agent the app ships; the Windows app window itself was not driven. macOS was not tested. |
| [Windsurf (Devin Desktop)](windsurf.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Cline](cline.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Zed](zed.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [JetBrains AI Assistant](jetbrains.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |
| [Continue](continue.md) | MCP server | No | No | Only servers you wrap | No | Not yet verified |

"Only servers you wrap" means that the results of the MCP servers you start through `zn-gate shield` are checked; each page shows how. The hooks need zn-gate 1.5 or later from npm (`npm install -g zn-gate`). Per-agent details for the hooks: [compat.md](../compat.md).

## Experimental hooks

Gemini CLI has an experimental hook adapter. It is listed apart from the seven supported agents above (Claude Code, Codex CLI, OpenCode, Cursor, GitHub Copilot, Google Antigravity and the ZCode desktop app) and is less tested. It blocks reads and writes of secret files by path and shell commands that handle secrets, and stops the agent from editing its own hook or settings files.

Google replaced Gemini CLI with Antigravity CLI for free and Google One accounts on June 18, 2026. Gemini CLI keeps working with zn-gate as an experimental adapter.

| Agent | Setup | What it does not do |
| - | - | - |
| Gemini CLI | `zn hooks install gemini` | Does not change what a tool returns. Its hooks cannot ask for confirmation, so zn blocks what it would ask about and says why. Gemini CLI lets a call run when a hook crashes or times out, so zn blocks it instead (a hook that fails is answered with a block, and zn sets a 15-second timeout on its hook and answers a check still running after 11 seconds with a block). Checked end to end with Gemini CLI 0.64.0. |

Details: [compat.md](../compat.md) (Gemini CLI and GitHub Copilot) and [threat-model.md](../threat-model.md) (Gemini CLI, Copilot and Antigravity).

For GitHub Copilot, the evidence level is: documented, not tested in the VS Code app (see [its page](vscode.md)); a typed prompt cannot be blocked and a hook that times out lets the call through, so zn blocks the call itself at 11 seconds. Windsurf has its own agent hooks, but zn-gate does not install hooks for it yet. For what Antigravity's hooks cover and what they do not, see [its page](antigravity.md); for ZCode, see [its page](zcode.md).

To remove zn-gate from an editor by hand, see [the files zn-gate writes in each editor](remove-by-hand.md).
