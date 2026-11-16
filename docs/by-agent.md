# Install, verify and uninstall by agent

A short list of the steps for each of the eight agents zn-gate can install hooks for: seven supported, plus Gemini CLI, which is experimental. Run every command in your own terminal. For what each agent is and is not protected against, see [Editors and coding agents](editors/README.md); each editor has its own page with the full steps.

Verifying is the same for every agent that has hooks: `npx -y zn-gate check` makes a temporary folder with a fake `.env` file, asks the hook to read it, and reports whether it was blocked. See [Check that it works](check.md). To remove everything at once, run `npx -y zn-gate uninstall`: see [Remove zn-gate](uninstall.md). To move from one agent to another, follow the [switching agents checklist](examples/switching-agents-checklist.md).

## Symptoms for hooks

If the hooks of an agent do not seem to work, start with the page of that agent. Each one has a symptom section; ZCode has none yet, so use the general list.

| Agent | Where to look |
| - | - |
| Claude Code | [The plugin rejects every call, or its MCP servers show "Failed to connect"](troubleshooting.md#11-the-claude-code-plugin-rejects-every-call-or-its-mcp-servers-show-failed-to-connect); [Your agent says "zn-gate is not installed any more"](troubleshooting.md#18-your-agent-says-zn-gate-is-not-installed-any-more) |
| Codex CLI | [Troubleshooting](editors/codex.md#troubleshooting); [Codex asks you to trust the hooks again](editors/codex.md#codex-asks-you-to-trust-the-hooks-again) |
| OpenCode | [Troubleshooting](editors/opencode.md#troubleshooting) |
| Cursor | [Troubleshooting](editors/cursor.md#troubleshooting) |
| GitHub Copilot (VS Code, CLI) | [Troubleshooting](editors/vscode.md#troubleshooting) |
| Google Antigravity | [Troubleshooting](editors/antigravity.md#troubleshooting) |
| ZCode desktop app | [Symptom index](troubleshooting.md#symptom-index) |
| Gemini CLI | [Troubleshooting](editors/gemini.md#troubleshooting); [When a Gemini CLI setting switches the hook off](editors/gemini.md#when-a-gemini-cli-setting-switches-the-hook-off) |

For any agent: [Your agent ignores zn's hooks on a managed computer](troubleshooting.md#9-your-agent-ignores-zns-hooks-on-a-managed-computer), and the list of [symptoms by command](troubleshooting.md#symptoms-by-command).

## Agents with hooks

The hooks need zn-gate 1.5 or later from npm (`npm install -g zn-gate`).

| Agent | Install | Verify | Uninstall |
| - | - | - | - |
| Claude Code | `claude plugin marketplace add usezn/zn`, then `claude plugin install zn-gate@usezn` (or `zn hooks install claude-code`) | `npx -y zn-gate check` | `claude plugin uninstall zn-gate@usezn` (or `zn hooks uninstall claude-code`) |
| Codex CLI | [`zn hooks install codex`](editors/codex.md), then trust it in `/hooks` | `npx -y zn-gate check` | `zn hooks uninstall codex` |
| OpenCode | `zn hooks install opencode` | `npx -y zn-gate check` (checks zn's rules; the plugin runs inside OpenCode) | `zn hooks uninstall opencode` |
| [Cursor](editors/cursor.md) | `zn hooks install cursor` | `npx -y zn-gate check` | `zn hooks uninstall cursor` |
| [GitHub Copilot (VS Code, CLI)](editors/vscode.md) | `zn hooks install copilot` | `npx -y zn-gate check` | `zn hooks uninstall copilot` |
| [Google Antigravity](editors/antigravity.md) | `zn hooks install antigravity` | `npx -y zn-gate check` | `zn hooks uninstall antigravity` |
| [ZCode desktop app](editors/zcode.md) | `zn hooks install zcode` | `npx -y zn-gate check` | `zn hooks uninstall zcode` |
| Gemini CLI (experimental) | `zn hooks install gemini` | `npx -y zn-gate check` | `zn hooks uninstall gemini` |

Add `--project` to the install and uninstall commands to work on one project only; run them from that project's folder (ZCode has no project hooks, so leave it out there). A backup of the settings file is written first. More: [Remove zn-gate](uninstall.md#piece-by-piece). To remove by hand, use the order `npx -y zn-gate uninstall` uses: put back wrapped MCP servers first (`npx -y zn-gate init --revert`, for the agents `init --wrap-mcp` changes: Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity), then the hooks. Remove the program last, yourself (`npm uninstall -g zn-gate`).

## Agents with MCP only

zn-gate does not install hooks for these yet. You add the zn-gate MCP server to the agent's settings by hand, and zn-gate can check the output of your other MCP servers that you start through `zn-gate shield`.

| Agent | Install | Verify | Uninstall |
| - | - | - | - |
| [Windsurf (Devin Desktop)](editors/windsurf.md) | [Install steps](editors/windsurf.md#install-no-coding-needed) | [Verify](editors/windsurf.md#verify) | [Uninstall](editors/windsurf.md#uninstall) |
| [Cline](editors/cline.md) | [Install steps](editors/cline.md#install-no-coding-needed) | [Verify](editors/cline.md#verify) | [Uninstall](editors/cline.md#uninstall) |
| [Zed](editors/zed.md) | [Install steps](editors/zed.md#install-no-coding-needed) | [Verify](editors/zed.md#verify) | [Uninstall](editors/zed.md#uninstall) |
| [JetBrains AI Assistant](editors/jetbrains.md) | [Install steps](editors/jetbrains.md#install-no-coding-needed) | [Verify](editors/jetbrains.md#verify) | [Uninstall](editors/jetbrains.md#uninstall) |
| [Continue](editors/continue.md) | [Install steps](editors/continue.md#install-no-coding-needed) | [Verify](editors/continue.md#verify) | [Uninstall](editors/continue.md#uninstall) |

`npx -y zn-gate check` does not test these setups, because it checks hooks. To uninstall, delete the `zn-gate` entry from the settings file you edited and restart the agent. `init --wrap-mcp` does not change these editors' settings, so `npx -y zn-gate init --revert` has nothing to put back for them.
