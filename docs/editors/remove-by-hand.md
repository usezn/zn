# Files zn-gate writes in each editor, and how to remove them by hand

For each supported editor, this page lists the files zn-gate writes and what to delete from them if you want to remove zn-gate yourself. To remove everything in one step, run `npx -y zn-gate uninstall` (see [Remove zn-gate](../uninstall.md)). Run every command in your own terminal.

`~` is your user folder, for example `C:\Users\you` on Windows. Before it changes a settings file, zn-gate saves a copy next to it, so you can also put that copy back (changes you made to the file since are lost).

## Editors where zn-gate installs hooks

### Cursor

`zn hooks install cursor` writes:

| File | What zn-gate put there | How to remove it |
| - | - | - |
| `~/.cursor/hooks.json` (or `.cursor/hooks.json` in the project, with `--project`) | One hook entry of zn-gate in each of the events `beforeMCPExecution`, `beforeReadFile`, `beforeSubmitPrompt`, `beforeShellExecution`, `postToolUse` and `preToolUse`. The command of each entry runs `zn hook cursor`, or the launcher below. | `zn hooks uninstall cursor` (add `--project` for a project install). By hand: delete those entries and keep your own. |
| `~/.cursor/hooks.json.bak-zn-<date>` | A copy of the file as it was before the change. | Delete it when you no longer need it. |
| `~/.zn/hooks/zn-hook-cursor.sh` | A small launcher script (user install only; on Windows the steps are written inline in the hook commands instead). | Delete the file. `hooks uninstall` leaves it in place, because other Cursor settings on the machine may use it; `zn-gate uninstall` removes it. |

zn-gate does not write to `~/.cursor/mcp.json` on its own. It prints the `secrets` server entry as an optional step; if you added it, delete the `secrets` entry under `mcpServers`. If you wrapped servers with `init --wrap-mcp`, run `npx -y zn-gate init --revert`, or in `~/.cursor/mcp.json` put each server's original command back in place of `npx -y zn-gate shield -- …`. The saved copy is `~/.cursor/mcp.json.bak.<number>`.

### Google Antigravity (experimental)

`zn hooks install antigravity` writes:

| File | What zn-gate put there | How to remove it |
| - | - | - |
| `~/.gemini/config/hooks.json` (or `.agents/hooks.json` in the project, with `--project`) | A hook handler of zn-gate that runs `zn hook antigravity`, or the launcher below. | `zn hooks uninstall antigravity` (add `--project` for a project install). By hand: delete the zn-gate handlers; if a hook entry held only zn-gate's handlers, delete the entry too. |
| `hooks.json.bak-zn-<date>`, next to that file | A copy of the file as it was before the change. In a project, do not commit it. | Delete it when you no longer need it. |
| `~/.zn/hooks/zn-hook-antigravity.sh` | A small launcher script (user install only; on Windows the steps are written inline). | Delete the file. `hooks uninstall` leaves it in place; `zn-gate uninstall` removes it. |

If you wrapped servers with `init --wrap-mcp`, the files are `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json` and, for one project, `.agents/mcp_config.json`. Run `npx -y zn-gate init --revert`, or put each server's original command back by hand. The saved copy sits next to the file, named `<file>.bak.<number>`.

## Editors where zn-gate is only an MCP server

For [VS Code](vscode.md), [Windsurf](windsurf.md), [Cline](cline.md), [Zed](zed.md), [JetBrains AI Assistant](jetbrains.md) and [Continue](continue.md), zn-gate installs no hooks and writes no file of its own, and `init --wrap-mcp` does not edit their settings. The only changes are the ones you made by hand, following the editor's page. To remove them, edit the same file and take out the entries you added: the `zn-gate` server, and for each server you wrapped, the `npx -y zn-gate shield --` in front of its original command.

| Editor | Where the entries are |
| - | - |
| VS Code | `mcp.json` (open it with **MCP: Open User Configuration**), or `.mcp.json` / `.vscode/mcp.json` in a project |
| Windsurf | `~/.config/devin/mcp_config.json` (macOS and Linux), `%APPDATA%\devin\mcp_config.json` (Windows) |
| Cline | the file opened by **Configure MCP Servers** (Cline CLI: `~/.cline/data/settings/cline_mcp_settings.json`) |
| Zed | `settings.json`, key `context_servers` |
| JetBrains AI Assistant | Settings → Tools → AI Assistant → Model Context Protocol (MCP) |
| Continue | `config.yaml`, or a file in `.continue/mcpServers/` in the project |

## Check that it is off

```bash
npx -y zn-gate check
```

It says which part, if any, is still set up.

## Related

- [Remove zn-gate](../uninstall.md)
- [Editors and coding agents](README.md)
- [Every command and exit code](../cli.md#uninstall)
