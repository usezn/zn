# Install, verify and uninstall by agent

A short list of the steps for each of the eight agents zn-gate can install hooks for: seven supported, plus Gemini CLI, which is experimental. Run every command in your own terminal. For what each agent is and is not protected against, see [Editors and coding agents](editors/README.md); each editor has its own page with the full steps.

Verifying is the same for every agent that has hooks: `npx -y zn-gate check` makes a temporary folder with a fake `.env` file, asks the hook to read it, and reports whether it was blocked. See [Check that it works](check.md). To remove everything at once, run `npx -y zn-gate uninstall`: see [Remove zn-gate](uninstall.md).

## Agents with hooks

The hooks need zn-gate 1.5 or later from npm (`npm install -g zn-gate`).

| Agent | Install | Verify | Uninstall |
| - | - | - | - |
| Claude Code | `claude plugin marketplace add usezn/zn`, then `claude plugin install zn-gate@usezn` (or `zn hooks install claude-code`) | `npx -y zn-gate check` | `claude plugin uninstall zn-gate@usezn` (or `zn hooks uninstall claude-code`) |
| Codex CLI | `zn hooks install codex`, then trust it in `/hooks` | `npx -y zn-gate check` | `zn hooks uninstall codex` |
| OpenCode | `zn hooks install opencode` | `npx -y zn-gate check` (checks zn's rules; the plugin runs inside OpenCode) | `zn hooks uninstall opencode` |
| [Cursor](editors/cursor.md) | `zn hooks install cursor` | `npx -y zn-gate check` | `zn hooks uninstall cursor` |
| [GitHub Copilot (VS Code, CLI)](editors/vscode.md) | `zn hooks install copilot` | `npx -y zn-gate check` | `zn hooks uninstall copilot` |
| [Google Antigravity](editors/antigravity.md) | `zn hooks install antigravity` | `npx -y zn-gate check` | `zn hooks uninstall antigravity` |
| [ZCode desktop app](editors/zcode.md) | `zn hooks install zcode` | `npx -y zn-gate check` | `zn hooks uninstall zcode` |
| Gemini CLI (experimental) | `zn hooks install gemini` | `npx -y zn-gate check` | `zn hooks uninstall gemini` |

Add `--project` to the install and uninstall commands to work on one project only; run them from that project's folder. A backup of the settings file is written first. More: [Remove zn-gate](uninstall.md#piece-by-piece).

## Agents with MCP only

zn-gate does not install hooks for these yet. You add the zn-gate MCP server to the agent's settings by hand, and zn-gate can check the output of your other MCP servers that you start through `zn-gate shield`.

| Agent | Install | Verify | Uninstall |
| - | - | - | - |
| [Windsurf (Devin Desktop)](editors/windsurf.md) | [Install steps](editors/windsurf.md#install-no-coding-needed) | [Verify](editors/windsurf.md#verify) | [Uninstall](editors/windsurf.md#uninstall) |
| [Cline](editors/cline.md) | [Install steps](editors/cline.md#install-no-coding-needed) | [Verify](editors/cline.md#verify) | [Uninstall](editors/cline.md#uninstall) |
| [Zed](editors/zed.md) | [Install steps](editors/zed.md#install-no-coding-needed) | [Verify](editors/zed.md#verify) | [Uninstall](editors/zed.md#uninstall) |
| [JetBrains AI Assistant](editors/jetbrains.md) | [Install steps](editors/jetbrains.md#install-no-coding-needed) | [Verify](editors/jetbrains.md#verify) | [Uninstall](editors/jetbrains.md#uninstall) |
| [Continue](editors/continue.md) | [Install steps](editors/continue.md#install-no-coding-needed) | [Verify](editors/continue.md#verify) | [Uninstall](editors/continue.md#uninstall) |

`npx -y zn-gate check` does not test these setups, because it checks hooks. To uninstall, delete the `zn-gate` entry from the settings file you edited and restart the agent. If you ran `npx -y zn-gate init --wrap-mcp`, `npx -y zn-gate init --revert` puts back each MCP settings file as it was saved before wrapping.
