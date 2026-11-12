# Example: a safe first day with a new agent

A short walk-through for when you start using a new coding agent and want to see zn-gate work with it before you trust it with a real project. You try it in a throwaway folder, and take it out again when you are done. The example uses Claude Code. The folder name, the key and the values are made up.

Run every command in your own terminal, not through your agent. This page uses `--project`, which changes only the settings of the folder you are in, so your own settings and your other projects are not touched. It needs zn-gate installed globally (`npm install -g zn-gate`), because the project hooks run `zn` from your PATH. More: [`hooks`](../cli.md#hooks).

## 1. Make an empty folder

```bash
mkdir ~/try-zn
cd ~/try-zn
```

Everything below happens in this folder.

## 2. Install the hooks for this folder only

```bash
zn-gate hooks install claude-code --project
```

It writes zn's hooks into `.claude/settings.json` inside `try-zn`. It prints:

```text
Installed zn hooks for claude-code in ~/try-zn/.claude/settings.json
  note: a project install adds no MCP server: to use zn's secrets tools in Claude Code, run `zn hooks install claude-code` (your user settings)
```

The path is the one on your computer. If `zn` is not on your PATH, the install adds a second note that says so: install zn-gate globally first, or the hooks fail in this folder.

`--project` works for Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, GitHub Copilot and Gemini CLI. It does not work for ZCode, which has no project hooks. Each agent keeps its project hooks in its own file:

| Agent | Command | File in the folder |
| --- | --- | --- |
| Claude Code | `hooks install claude-code --project` | `.claude/settings.json` |
| Codex CLI | `hooks install codex --project` | `.codex/hooks.json` |
| Cursor | `hooks install cursor --project` | `.cursor/hooks.json` |
| OpenCode | `hooks install opencode --project` | `.opencode/plugins/zn-gate.js` |
| Antigravity | `hooks install antigravity --project` | `.agents/hooks.json` |
| GitHub Copilot | `hooks install copilot --project` | `.github/hooks/zn-gate.json` |
| Gemini CLI | `hooks install gemini --project` | `.gemini/settings.json` |

To see that the hooks are in place, and where:

```bash
zn-gate check --hooks
```

```text
Claude Code (project): ~/try-zn/.claude/settings.json
```

The line names the project file, and the list under it shows each hook with `OK` and ends with `6 OK, 0 stale, 0 broken.`

## 3. Add a fake `.env`

```bash
printf 'API_TOKEN=sk-live-EXAMPLEEXAMPLEEXAMPLE1234\n' > .env
```

The key is made up. Never put a real key in a test file.

## 4. Ask your agent to read it

Start your agent in `~/try-zn` and ask it: "Read the file .env". zn's hook looks at the call before the agent runs it, and blocks it. The agent is told this, word for word:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets. Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."}}
```

`deny` is the block, and the sentence after it is the next step. What your screen shows depends on the agent. You do not need to run `zn env shadow` for this test: the key is fake. See [First 5 minutes](../first-5-minutes.md#a-block) for what each answer means.

## 5. Run `zn-gate check`

```bash
zn-gate check
```

Here `check` does not test the folder's hooks. It tests the setup for your user, and for a project-only install it says so:

```text
  -  Claude Code  zn is set up only for one project (~/try-zn/.claude/settings.json). This check covers the setup for your user; to protect every project, install the zn-gate plugin (needs internet): `claude plugin marketplace add usezn/zn#v1.15.0`, then `claude plugin install zn-gate@usezn`.
```

That is the expected line here: a project install is separate from your user setup. To see the project's hooks, use `zn-gate check --hooks` from step 2. See [check](../check.md).

## 6. Remove the hooks and the folder

```bash
zn-gate hooks uninstall claude-code --project
```

Run it from `~/try-zn`. It prints:

```text
Removed zn hooks for claude-code in ~/try-zn/.claude/settings.json
  backup: ~/try-zn/.claude/settings.json.bak-zn-20261107T213243
```

The backup name ends with the date and time of your run. `zn-gate check --hooks` no longer lists a project line for this folder. Then delete the folder, which also deletes the backup and the fake `.env`:

```bash
cd ~
rm -rf ~/try-zn
```

Check the path before you run `rm -rf`. If you decide to keep the agent, run `npx -y zn-gate init` to protect all your projects, as in [First 5 minutes](../first-5-minutes.md).

## More

- [`hooks install` and `hooks uninstall` in the command reference](../cli.md#hooks)
- [Remove zn-gate: every option](../uninstall.md)
- [Which agents zn-gate supports](../by-agent.md)
