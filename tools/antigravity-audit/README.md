# Antigravity hooks audit kit

A developer tool for checking how Google Antigravity (App, CLI and IDE) calls hooks.
It is not part of the zn-gate npm package and nothing here changes what zn-gate does.

Files:

- `shape-audit-hook.js`: the hook. It records the shape of each payload (event, tool name, keys, value types and lengths). It never records values. It always allows the call, unless you start it with a `--probe` mode.
- `CHECKLIST.md`: the steps for a human run, and which open point each step answers.
- `hooks-example.json`: the hooks.json entries to copy.

Requirements: Node.js 18 or newer, no npm packages.

## Install in Antigravity (on your own machine)

1. Put the folder somewhere stable, for example `C:\zn-audit\` on Windows or `~/zn-audit/` on macOS and Linux.
2. Find the full path to `node`. On Windows, run `where node` in PowerShell. Use the full path if `node` is not on PATH for Antigravity.
3. Open `%USERPROFILE%\.gemini\config\hooks.json` (Windows) or `~/.gemini/config/hooks.json` (macOS and Linux). Create the file if it does not exist. If it already has content, add the `zn-audit-shape` entry from `hooks-example.json` next to your own entries. Do not delete the others.
4. Replace the script path with the absolute path to `shape-audit-hook.js`. Use forward slashes or doubled backslashes inside the JSON.
5. Restart Antigravity. In the CLI, type `/hooks` to confirm `zn-audit-shape` is loaded. In the App and the IDE, open Settings > Customizations > Hooks.
6. Follow `CHECKLIST.md`. Each action writes one or more lines to the output file.

Output file: `%USERPROFILE%\zn-antigravity-audit.jsonl` (Windows) or `~/zn-antigravity-audit.jsonl`. To choose another path, set the `ZN_AUDIT_OUT` environment variable before starting Antigravity.

## Remove it

Delete the `zn-audit-shape` and `zn-audit-probe` entries from hooks.json, then restart Antigravity. The output file can be deleted at any time.

## Send back the results

Send the `.jsonl` file to the zn team. Before sending, open it and check that it holds only key names, types, lengths and short labels. It should contain no file contents, commands or paths. If you see anything that looks like a value you typed, do not send the file; tell the team instead.

## Self-test

    node shape-audit-hook.js --selftest

Prints `SELFTEST OK` when the record builder leaks no test values.
