# Agent compatibility

What the secrets scrubber and broker can do in each agent. It depends on what
each agent's hooks allow; formats were checked against each agent's official
documentation on 2026-10-11. End-to-end evidence is in [`bench/e2e/`](../bench/e2e/).

| | Claude Code | Codex CLI | Cursor (IDE) | OpenCode |
|---|---|---|---|---|
| Install | `zn hooks install claude-code` | `zn hooks install codex`, then trust in `/hooks` | `zn hooks install cursor` | `zn hooks install opencode` |
| Mechanism | Hooks (`settings.json`) | Hooks (`hooks.json`) | Hooks (`hooks.json`) | Plugin (`plugins/zn-gate.js`) |
| Block reads of `.env` with values, credential files, `~/.zn` | Yes (Read, Grep, LSP, shell) | Yes (shell, `apply_patch` into `~/.zn`) | Yes (file reads, shell) | Yes (all tools) |
| Block writes to `~/.zn` and to the agents' hook and plugin configuration | Yes (Write, Edit, shell) | Yes (`apply_patch`, checked file by file; shell) | **Best effort**: Write, Delete and Grep through `preToolUse`; shell through `beforeShellExecution` | Yes (write, edit, `apply_patch`, shell) |
| Scrub tool output before the model sees it | **Yes, every tool** (Bash, PowerShell, Read, Grep, LSP, WebFetch, MCP, MCP resources; Monitor through a streaming filter) | **Yes, lossy**: the result is replaced by its scrubbed text | **MCP output only**; shell and file output cannot be rewritten | **Yes, every tool** (and the TUI preview) |
| Block a pasted secret in the prompt | Yes | Yes | Yes | Yes (OpenCode shows it as an error) |
| Commands with `__ZN_<NAME>__`: through `zn run` | Rewritten automatically, shown to you for confirmation | The agent is told the exact `zn run -- …` line to use | The agent is told the exact `zn run -- …` line to use; Cursor asks you once wrapped | Rewritten automatically; OpenCode's own permission rules apply |
| Restore detected tokens into local commands and git-ignored files | Yes, shown in the confirmation dialog | No (tokens stay) | No (tokens stay) | No (tokens stay) |
| `secrets` MCP server | Yes (registered on install) | Yes (snippet printed) | Yes (snippet printed) | Yes (snippet printed) |
| Windows | Yes, including the PowerShell tool | The hook command was run by hand from PowerShell and from cmd.exe (not in CI) | Not tested | Not tested (wrapping is written for bash) |
| End-to-end run, 0 values sent to the provider | **Yes** | **Yes** | Not run (no CLI with hooks to drive) | **Yes** |

## Why the differences

- **Claude Code**: `PostToolUse` can replace the output of any tool
  (`updatedToolOutput`), and `PreToolUse` can rewrite the input and ask the user
  (`ask` + `updatedInput`). zn never returns `allow`, so your own permission
  rules always apply.
- **Codex CLI**:
  - Rewriting a call (`updatedInput`) is only accepted together with `allow`,
    which would skip your approval policy, and `ask` is not supported. So zn
    denies the call and tells the agent the exact `zn run` command. Once the
    agent uses it, Codex's approval policy applies.
  - PostToolUse cannot rewrite output; `decision: "block"` replaces the result
    with zn's scrubbed copy. The model gets text instead of the structured
    result.
  - Codex's own session log keeps the original output.
  - Hooks are a guardrail, not an enforcement boundary (Codex's own words).
- **Cursor** (best effort: its hook documentation leaves the input of some
  tools open, and zn fails closed where it cannot read a path):
  - `beforeReadFile` can only allow or deny. zn sets `failClosed: true` on it
    and on `beforeSubmitPrompt`, so a hook that crashes or times out blocks the
    read or the prompt.
  - `preToolUse` (Write, Delete, Grep) checks the file a call names with the
    same rules as the other tools. Cursor does not document the input keys of
    these tools, so zn looks for the usual names (`file_path`, `path`,
    `target_file`). A write whose file cannot be read is refused.
  - A call zn has no objection to gets no answer, not `allow`: an `allow` could
    skip Cursor's own confirmations. A Grep without a `path` searches the whole
    workspace, so files that zn would shadow or refuse can be found that way;
    zn does not filter those results.
  - `postToolUse` can only replace the output of MCP tools.
  - `preToolUse` rewrites only together with `allow`, and does not enforce `ask`.
  - Not covered: a secret written inside inline code (for example
    `python -c "open(...)"`) is checked only where zn can read the path as a word.
  - **A secret printed by a shell command, or in a file the agent reads that is
    not blocked, reaches the model.** Shadow your `.env` files and keep secrets
    in the vault.
  - The Cursor CLI (`cursor-agent`) is not covered: its hook support is not
    documented and is reported incomplete.
- **OpenCode**:
  - `tool.execute.before` and `tool.execute.after` let zn change arguments and
    output in place.
  - zn never restores detected values into arguments, because OpenCode keeps
    the arguments it ran with in the session, where the model can read them.
  - zn does not rely on `shell.env`, which the current bash tool does not apply.
  - The model sees the wrapped command in its own history, including the
    local paths of `node` and zn (no secret value).
  - Live output that OpenCode stores while a command runs stays in its local
    database.
  - On Windows, the `zn run` wrapping is written for bash: with PowerShell as
    OpenCode's shell, a command with a marker fails instead of running (no
    value is exposed).

## Files a `--project` install writes

A project install names `zn` on your PATH (`zn hook <agent>`), not the paths of
your user, so these files can be committed. Add them to `.gitignore` if you
want them to stay on your machine. Each agent's own hook trust still applies
(Codex asks you to review project hooks in `/hooks`).

| Agent | File |
|---|---|
| Claude Code | `.claude/settings.json` |
| Codex CLI | `.codex/hooks.json` |
| Cursor | `.cursor/hooks.json` |
| OpenCode | `.opencode/plugins/zn-gate.js` |

A user install writes the same files under your home directory and names the
node and runner paths of that install.

A teammate who clones the project without zn on PATH gets no checks from these
files: the hook command fails, and in Claude Code and Codex the call goes ahead.
Install zn on every machine that runs the agent.

## Limits that apply to every agent

- **An event zn cannot read is refused.** Empty stdin, or stdin that is not
  JSON, exits with code 2 and the reason on stderr. Claude Code and Codex block
  the call on exit code 2; Cursor also gets its deny answer. Setting
  `whenUnavailable` to `"allow"` in `~/.zn/config.json` lets such events pass.

- **The unlocked vault answers any program of your user.** A command the
  agent runs can ask the vault daemon for a stored secret by name; the
  command allow-list, first-use confirmation and host rules protect `zn run`
  and the `secrets` MCP server, not that direct request. Lock the vault when
  you do not need it and keep your agent's own approval rules for commands on.
  Details: [threat-model.md](threat-model.md#what-the-vault-daemon-protects-and-what-it-does-not).
- **Approved scripts, and every program on macOS and Windows,** are started by
  path right after zn's last check; see
  [threat-model.md](threat-model.md#starting-the-approved-program).

## Not covered yet

Hermes Agent, Gemini CLI, Copilot CLI and the Cursor CLI. A proxy for outgoing
HTTP from `zn run` (for `curl`, `gh` or SDKs) is planned for a later release.
