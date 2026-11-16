# Example: installing hooks with a custom `ZN_HOME`

By default zn-gate keeps its own files in `~/.zn`. The environment variable `ZN_HOME` names another folder for them. This page shows, with a throwaway folder, where the files of a hook install go and what the hooks refer to, then how to check and clean up. For the full reference, read the [CLI page](../cli.md#hooks-install) and [Files and folders](../files-and-folders.md).

The output below comes from real runs of the commands. To touch none of your real settings, the runs used a throwaway home folder as well: `HOME` was set to a new empty folder, and `ZN_HOME` to a folder inside it. Paths are shown under `~`, where `~` is that throwaway folder, and the long `commandWindows` line of the settings file is left out.

## Why you need both for a trial

`ZN_HOME` moves zn's own files only (see [all environment variables](../cli.md#all-environment-variables)). The settings file of your coding agent stays where the agent keeps it, in your home folder. So `hooks install` with only `ZN_HOME` set still edits your real agent settings. If you only want to look, set a throwaway `HOME` too (on Linux and macOS; the runs here were on Linux).

```bash
TRIAL="$(mktemp -d)"
export HOME="$TRIAL"
export ZN_HOME="$TRIAL/custom-zn"
mkdir -p "$ZN_HOME"
```

Run the next commands in that same terminal. They need an interactive terminal: run them yourself, not through an agent.

## 1. Install the hooks for one agent

```bash
npx -y zn-gate hooks install codex
```

```text
Installed zn hooks for codex in ~/.codex/hooks.json
  note: Codex runs new or changed hooks only after you trust them: open Codex and review them with /hooks.
```

The command goes on with a note about the optional `secrets` MCP server. Codex CLI is the example. For other agents, use the names in [Install, verify and uninstall by agent](../by-agent.md).

## 2. Where the files went

Two files were written, and nothing else:

```text
~/.codex/hooks.json
~/custom-zn/hooks/zn-hook-codex.sh
```

- The launcher script, `zn-hook-codex.sh`, went into the `hooks` folder under `ZN_HOME`. `ZN_HOOK_DIR` names another folder for the launchers, as the [variable table](../cli.md#all-environment-variables) says.
- The agent's own settings file, `~/.codex/hooks.json`, stayed in the home folder of the agent.

## 3. What the hooks refer to

Each hook in the settings file runs the launcher by its full path, in the `command` field:

```text
"command": "'~/custom-zn/hooks/zn-hook-codex.sh' PreToolUse",
```

The settings file does not mention `ZN_HOME` itself. The path of the launcher is written into it when you install.

## 4. Check the hooks

```bash
npx -y zn-gate check --hooks
```

```text
zn hooks installed on this machine (nothing was run or changed):

Codex CLI (user): ~/.codex/hooks.json
  OK     PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/custom-zn/hooks/zn-hook-codex.sh' PreToolUse
  ...

7 OK, 0 stale, 0 broken.
```

All seven hook lines said OK; six of them are left out here. The exit code is 0. This worked the same with `ZN_HOME` set and with it unset in the shell that ran the check, because the check follows the paths that are written in the settings file.

## 5. Keep `ZN_HOME` in the environment of your agent

The launcher script does not set `ZN_HOME`. A hook runs in the environment of your agent, so it uses the folder that the agent's environment names. To see it, the installed launcher was run by hand with an ordinary hook event. You do not do this yourself in normal use: the agent runs the launcher. First without `ZN_HOME` in its environment, then with it:

```bash
EVENT='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"cwd":".","session_id":"s1"}'
echo "$EVENT" | env -u ZN_HOME sh "$ZN_HOME/hooks/zn-hook-codex.sh" PreToolUse
echo "$EVENT" | sh "$ZN_HOME/hooks/zn-hook-codex.sh" PreToolUse
ls "$HOME/.zn" "$ZN_HOME"
```

Both runs exit with 0. After the first, `stats.json` and a small `cache` folder were in `~/.zn`, the folder that is used when `ZN_HOME` is not set. After the second, the same two were in `~/custom-zn`. So if you want zn's files, such as the decision log and the statistics, in the custom folder, set `ZN_HOME` where your agent starts, not only in the terminal where you installed.

Hook settings that turn a check off, relax it or turn on a network lookup (for example `egressCheck: "off"` or `packageInstallCheck: "online"`) are read only from `~/.zn/config.json` in your operating-system account's home folder. A `config.json` in the folder `ZN_HOME` names can only add protection, because a project can set `ZN_HOME` for the agent.

## 6. Clean up

```bash
npx -y zn-gate hooks uninstall codex
```

```text
Removed zn hooks for codex in ~/.codex/hooks.json
  backup: ~/.codex/hooks.json.bak-zn-<date>
```

`hooks uninstall` writes a backup of the settings file first, removes the hooks and leaves the launcher script in place, because other settings on the machine may use it. `zn-gate check --hooks` then prints `None found.` and exits with 0. The throwaway folder is yours to delete. Delete the one you made and close the terminal, so the changed `HOME` and `ZN_HOME` go with it:

```bash
rm -r "$TRIAL"
```

## Related

- [Install, verify and uninstall by agent](../by-agent.md)
- [Install the hooks for one agent](zn-hooks-install-for-one-agent.md)
- [Install and remove hooks, for your user or one project](hooks-install-and-uninstall.md)
- [Files and folders zn-gate reads or writes](../files-and-folders.md)
