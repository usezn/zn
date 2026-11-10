# Example: install and uninstall the hooks of one agent

A short walk-through of `zn hooks install <agent>` and `zn hooks uninstall <agent>`, here for Claude Code: what each command changes, the difference between your user settings and one project, and how to check the result. Everything here is documented in the [command reference](../cli.md#hooks); this page just puts the steps in order. Run the commands yourself, in your own terminal.

## 1. Install the hooks for your user

```bash
npx -y zn-gate hooks install claude-code
```

zn first writes a backup of the settings file, then adds its hooks to it, and adds its own `secrets` MCP server unless you pass `--no-mcp`. It prints where it wrote:

```text
Installed zn hooks for claude-code in ~/.claude/settings.json
  backup: <the backup file>
```

With no option the change is for your user, so it covers every project you open with that agent. For Claude Code the file is `settings.json` in `~/.claude`, or in the folder named by `CLAUDE_CONFIG_DIR` if you set it.

If you installed the Claude Code plugin, do not also run this for Claude Code: both would run. See the [FAQ](../faq.md).

## 2. Or install them for one project only

```bash
cd my-project
npx -y zn-gate hooks install claude-code --project
```

`--project` changes the settings of the folder you are in instead of your user settings: for Claude Code, `.claude/settings.json` inside the project. That file is meant to be shared, so it runs `zn` from the PATH instead of a path on your machine. Everyone who uses the project needs zn-gate installed globally; zn prints a note when it is not on your PATH. For Claude Code, `--project` adds no `secrets` MCP server: run the command without `--project` for that.

The settings file depends on the agent. These are the files for five of them:

| Agent | User settings | Project settings |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` | `.claude/settings.json` |
| `codex` | `~/.codex/hooks.json` | `.codex/hooks.json` |
| `cursor` | `~/.cursor/hooks.json` | `.cursor/hooks.json` |
| `gemini` | `~/.gemini/settings.json` | `.gemini/settings.json` |
| `antigravity` | `~/.gemini/config/hooks.json` | `.agents/hooks.json` |

The full list of agents is in [the command reference](../cli.md#hooks). The install prints the exact file it changed, so you can always read it from there.

## 3. Check what is installed

```bash
npx -y zn-gate check --hooks
```

This lists every zn hook for your user and, from the folder you run it in, for the project. It only reads files: nothing is run, changed or sent. Each hook is `OK`, `STALE` (written by an older zn-gate) or `BROKEN`, with the command that fixes it. The last line counts them, for example `2 OK, 0 stale, 0 broken.` The exit code is `0` when every hook is OK and `1` otherwise. See [what the output means](../check.md#list-every-installed-hook).

## 4. Remove them again

```bash
npx -y zn-gate hooks uninstall claude-code
```

Add `--project` from the project folder if you installed them for the project. zn writes a backup of the settings file first and prints:

```text
Removed zn hooks for claude-code in ~/.claude/settings.json
```

For Claude Code this also removes zn's own `secrets` MCP server; add `--no-mcp` to leave MCP servers alone. The small launcher script under `~/.zn/hooks` stays, because other profiles of the same agent may use it. To remove zn-gate completely, use `npx -y zn-gate uninstall` instead, as described on the [remove page](../uninstall.md); for one agent only, see [remove zn-gate from one agent](uninstall-one-agent.md).

Run `check --hooks` again to see that the hooks are gone.

## When an agent runs it

Both commands only work for a person at a terminal. If an AI agent starts them, or there is no interactive terminal, zn changes nothing and refuses with exit code `77`, for example:

```text
zn hooks install must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).
```

An unknown agent name is refused first, with the list of supported names, and exit code `64`. This is on purpose: an agent must not be able to switch off its own protection. If you see the refusal while you are not using an agent, open a new terminal window and try again.

## More

- [`hooks` in the command reference](../cli.md#hooks)
- [Remove zn-gate: every option](../uninstall.md)
- [FAQ: when do I run `zn hooks install` again?](../faq.md)
- [Upgrading](../upgrading.md#run-zn-hooks-install-agent-again-when-a-release-changes-the-hook)
