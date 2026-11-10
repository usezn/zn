# Install, verify and uninstall by agent

A short list of the steps for each of the eight agents zn-gate can install hooks for: seven supported, plus Gemini CLI, which is experimental. Run every command in your own terminal. For what each agent is and is not protected against, see [Editors and coding agents](editors/README.md); each editor has its own page with the full steps.

Verifying is the same for every agent that has hooks: `npx -y zn-gate check` makes a temporary folder with a fake `.env` file, asks the hook to read it, and reports whether it was blocked. See [Check that it works](check.md). To remove everything at once, run `npx -y zn-gate uninstall`: see [Remove zn-gate](uninstall.md). To move from one agent to another, follow the [switching agents checklist](examples/switching-agents-checklist.md).

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

Add `--project` to the install and uninstall commands to work on one project only; run them from that project's folder. A backup of the settings file is written first. More: [Remove zn-gate](uninstall.md#piece-by-piece). To remove by hand, use the order `npx -y zn-gate uninstall` uses: put back wrapped MCP servers first (`npx -y zn-gate init --revert`, for the agents `init --wrap-mcp` changes: Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity), then the hooks, then the program (`npm uninstall -g zn-gate`).

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

## Where to look when a hook does not fire

Use this when your agent reads a file or runs a command that zn should have checked, and zn reports nothing. Run the commands in your own terminal. For a project hook, run them in that project's folder: `zn-gate check --hooks` lists the project hooks of the folder it runs in. (`packages/zn-gate/lib/hooks-list.js:130`)

1. Run `npx -y zn-gate check --hooks` (or `zn-gate check --hooks`). It lists each zn hook of each agent, with the settings file it is in, and marks each one `OK`, `STALE` or `BROKEN`. A line under a `STALE` or `BROKEN` row gives the command that fixes it. The command exits `1` when a hook is stale or broken and `0` when every hook is OK or none is set up. (`packages/zn-gate/lib/hooks-list.js:157-185`, `packages/zn-gate/bin/cli.js:1406-1410`; [List every installed hook](check.md#list-every-installed-hook))
2. Run `npx -y zn-gate check`. It tests the hook live with a fake `.env` file. A `NOT protected` line gives one reason and one repair: see [What each NOT protected line means](check.md#what-each-not-protected-line-means).
3. If the file in the table below does not show a zn hook, the hook is in another folder or profile. Check the environment variable named for your agent.

| Agent | Where zn writes the hook | Look here if it does not fire |
| - | - | - |
| Claude Code | `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set. Project: `.claude/settings.json`. (`packages/zn-gate/lib/agents/claude-code.js:287-295`) | The plugin's hooks are not in `settings.json`, so `check --hooks` does not list them. Read the [Claude Code plugin](check.md#claude-code-plugin) section of the check page. A second profile with its own `CLAUDE_CONFIG_DIR` has its own file: run the command with that variable set. |
| Codex CLI | `~/.codex/hooks.json`, or `$CODEX_HOME/hooks.json` when that variable is set. Project: `.codex/hooks.json`. (`packages/zn-gate/lib/agents/codex.js:317-324`) | Codex runs a new or changed user hook only after you approve it: open Codex, type `/hooks` and approve zn's hooks. (`packages/zn-gate/lib/agents/codex.js:12-13`) See also [The Codex hook is set up wrongly](check.md#the-codex-hook-is-set-up-wrongly). |
| OpenCode | A plugin file named `zn-gate.js` in `~/.config/opencode/plugins/`, or in `$XDG_CONFIG_HOME/opencode/plugins/` when that variable is set. Project: `.opencode/plugins/zn-gate.js`. (`packages/zn-gate/lib/agents/opencode.js:50`, `:300-308`) | `check --hooks` reports the plugin as `BROKEN` when it does not name the Node.js or the zn-gate files it runs, or when they are gone. (`packages/zn-gate/lib/hooks-list.js:96-107`) |
| Cursor | `~/.cursor/hooks.json`. Project: `.cursor/hooks.json`. (`packages/zn-gate/lib/agents/cursor.js:176-177`) | Cursor's plugin has its own section: [Cursor plugin](check.md#cursor-plugin). |
| GitHub Copilot (VS Code, CLI) | `zn-gate.json` in `$COPILOT_HOME/hooks/`, or in `~/.copilot/hooks/` when `COPILOT_HOME` is not set. Project: `.github/hooks/zn-gate.json`. (`packages/zn-gate/lib/agents/copilot.js:75`, `:346-353`; `packages/zn-gate/lib/check.js:137`) | Copilot asks each person to trust the folder before it runs the hooks of a repository. (`packages/zn-gate/lib/agents/copilot.js:410`) See also [Copilot CLI settings switch the hooks off](check.md#copilot-cli-settings-switch-the-hooks-off). |
| Google Antigravity | `~/.gemini/config/hooks.json`. Project: `.agents/hooks.json`. (`packages/zn-gate/lib/agents/antigravity.js:363-364`; `packages/zn-gate/lib/check.js:131`) | A project hook runs `zn` from your `PATH`. A teammate without zn-gate installed gets a deny from the hook, not a silent pass. (`packages/zn-gate/lib/agents/antigravity.js:475`) |
| Gemini CLI (experimental) | `~/.gemini/settings.json`. Project: `.gemini/settings.json`. (`packages/zn-gate/lib/agents/gemini.js:206-207`) | A setting in that file can switch the hook off: [Gemini CLI settings switch the hook off](check.md#gemini-cli-settings-switch-the-hook-off). |
| ZCode desktop app | `~/.zcode/cli/config.json` only. (`packages/zn-gate/lib/agents/zcode.js:314`) | ZCode runs only the hooks of that user file. A `.zcode/config.json` in a project is not read by ZCode. (`packages/zn-gate/lib/check.js:147-148`) See [ZCode settings switch the hook off](check.md#zcode-settings-switch-the-hook-off). |

If the file exists and shows a zn hook marked `OK`, and the agent still does not stop the call, run `npx -y zn-gate check`. If that test also fails, the output names the agent and the reason; [Troubleshooting](troubleshooting.md) lists the rest.
