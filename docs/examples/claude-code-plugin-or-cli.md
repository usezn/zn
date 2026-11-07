# Claude Code: the plugin or the command-line install

zn-gate covers Claude Code in two ways: the zn's hooks written into Claude Code's settings with `zn hooks install claude-code`. This page compares the two: what each needs, how to verify it, and how to remove it. The steps for all agents are in [Install, verify and uninstall by agent](../by-agent.md).

Run every command in your own terminal, not through your agent.

## The two ways at a glance

| | The plugin | The command-line install |
| - | - | - |
| Install | `claude plugin marketplace add usezn/zn`, then `claude plugin install zn-gate@usezn` | `zn hooks install claude-code` |
| Needs | Git and Claude Code 2.1.295 or later; Node.js 20.19 or later | Node.js 18 or later works for the hooks and the CLI |
| Verify | `npx -y zn-gate check` | `npx -y zn-gate check` |
| Remove | `claude plugin uninstall zn-gate@usezn` | `zn hooks uninstall claude-code` |

Do not keep both set up at the same time: the plugin and the hooks of `zn hooks install claude-code` would both run. If the hooks are already there, remove them with `zn hooks uninstall claude-code` first.

## What each way needs

**The plugin** needs Git and Claude Code 2.1.295 or later, and Node.js 20.19 or later. Node.js 22 LTS is recommended (from [nodejs.org](https://nodejs.org/)).

**The command-line install** needs zn-gate 1.5 or later from npm (`npm install -g zn-gate`); Node.js 18 or later works for the hooks and the CLI.

## Install the plugin

```bash
claude plugin marketplace add usezn/zn
claude plugin install zn-gate@usezn
```

Already ran `zn hooks install claude-code` before? Run `zn hooks uninstall claude-code` first, otherwise both sets of hooks run.

Start a new Claude Code session. Claude Code is then blocked from reading `.env` files with real values and credential files, secrets in what its tools return are replaced with markers or redacted before the model sees them, and a secret pasted into a prompt is blocked. The plugin adds no MCP server since version 1.14.0: for the `secrets` server, run `zn hooks install claude-code` instead of the plugin. Not covered: Claude Code sessions in the cloud, Cowork and chat. Details: [plugins/zn-gate](../../plugins/zn-gate/README.md).

## Install the command-line hooks

```bash
npm install -g zn-gate
zn hooks install claude-code
```

A backup of the settings file is written first. Add `--project` to the install command to work on one project only, and run it from that project's folder.

## Verify

For either setup, run in your own terminal:

```bash
npx -y zn-gate check
```

It makes a temporary folder with a fake `.env` file, asks the hook to read it, and reports whether it was blocked. For the plugin, it runs the PreToolUse command of the plugin's `hooks/hooks.json`, the way Claude Code runs it. A line like this means Claude Code is covered:

```text
OK Claude Code  blocked the .env file and allowed the ordinary file.
```

The check also notices when the plugin is turned off (run `claude plugin enable zn-gate@usezn` to turn it on) and when a Claude Code setting turns hooks off. If the plugin is a different version from the zn-gate command, the check names the one to update: the plugin (`claude plugin update zn-gate@usezn`) or the command (`npm install -g zn-gate@latest`). Each message and its fix are in [Check that it works](../check.md#claude-code-plugin).

## If your Node.js is older than 20.19

With an older Node.js, `npx -y zn-gate init` skips the plugin and sets up zn's hooks for Claude Code instead (`zn-gate check` says so if the plugin is installed); update Node.js to use the plugin.

## Remove

Remove the plugin with `claude plugin uninstall zn-gate@usezn`, or the hooks with `zn hooks uninstall claude-code`. To remove everything at once, run `npx -y zn-gate uninstall`: it lists what it found (the Claude Code plugin, zn's hooks for each agent, wrapped MCP servers), asks before removing, and ends with `zn-gate check`. Piece by piece: [Remove zn-gate](../uninstall.md).
