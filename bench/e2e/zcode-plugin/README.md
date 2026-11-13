# ZCode plugin: end-to-end evidence

The zn-gate plugin for the ZCode desktop app, run against the official app 3.16.3 (build 3.16.3.8992, Debian package) on Linux x64, on a throw-away cloud VM. The model is a fake local provider and every secret is a fictitious value (a `.env` with `FAKE_` values and the public AWS documentation example key).

## What ran

| Run | What it exercises | Result |
| --- | --- | --- |
| Headless, on the agent the app ships (`resources/glm/zcode.cjs`, run as the app runs it) | 29 cases: install through the runtime's plugin API, protection with `hooks.enabled` false, not set and true, no Node.js on the hook PATH, a changed vendored file, disable, enable, uninstall, update, `zn-gate check`, a double install with `zn hooks install zcode` | 29 of 29 pass: [results/results.md](results/results.md) |
| The app's own window (Settings, Plugins), driven with `xdotool` | Add the marketplace, install **Zn Gate**, see its four hooks in Settings, Hooks (read-only, in their own group), run a task with `hooks.enabled` false, turn the plugin off in Settings, Plugins and run it again | The `.env` read and `~/.aws/credentials` were blocked while the plugin was on and returned once it was off; ordinary commands ran in both: [gui/](gui/) |

## Findings that shaped the plugin

- ZCode copies the plugin folder and does not run `npm install`; a marketplace source of type `npm` is refused. The plugin therefore carries zn-gate inside it (`vendor/zn-gate`, checked against `scripts/zn-gate.lock.json` on every call).
- ZCode always loads `hooks/hooks.json` of the plugin root, so the ZCode plugin is its own tree (`plugins/zcode`), not the Claude Code one.
- ZCode runs a plugin's hooks whatever `hooks.enabled` says. The on/off switch of a plugin is `plugins.enabledPlugins["zn-gate@usezn"]` in `~/.zcode/cli/config.json`, and the installed list is `~/.zcode/cli/plugins/installed_plugins.json`: `zn-gate check` reads both.
- A hook that cannot start lets the call run, so every hook goes through `scripts/zn-hook.sh`, which finds Node.js (the hook's PATH, the usual install folders, then the app's own Node.js) and blocks with exit code 2 when it cannot run zn.
- With both the plugin and `zn hooks install zcode`, both run on every call (see case J3).
- The command line `uninstall` leaves the plugin's cache folder on disk; the plugin no longer loads.
- Each hook takes about 0.4 s (the first one of a session about 1.2 s): `h_latency` in the results.

## Not covered

macOS, hooks inside subagents, and the public marketplace listing. Windows is covered by [results-windows/](results-windows/results.md) (official app 3.16.3.8992 on Windows Server 2022, the app's own headless runtime, no window): the PowerShell hook starts, blocks the `.env` and `~/.aws/credentials` reads, lets an ordinary command run and blocks when no Node.js can be found. `zn-gate check` does not yet report the plugin as protected there (nor on Linux, since the plugin got its PowerShell hook): it reads the PowerShell command as started by name. The Windows window of the app (Settings, Plugins) was not driven.

## Files

- `results/`: the case table (`results.md`, `results.json`), the config and plugin files after each step, the `zn-gate check` outputs, and one `result.json` and `scenario.json` per case.
- `gui/`: screenshots of the app, the config files after the GUI install and after turning the plugin off, and the tool results the model received in each task.
- `results-windows/`: the Windows run and the Linux rerun on the PowerShell-hook branch (`results.md`, `results.json`, `windows/`, `linux/`).
- `kit-windows/`: the scripts of the Windows run (`entry.ps1`, `e2epw.py`, `zc_helpers_win.py`, `mcp_echo.py`); it also uses `fake_provider.py` and `hook_recorder.py` of `kit/`.
- `kit/`: the scripts that ran it (`e2ep.py` and `zc_helpers.py`, the fake provider, the hook recorder, the MCP echo server, `entry.sh`, the GUI steps).
