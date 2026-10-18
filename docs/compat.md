# Agent compatibility

What the secrets scrubber and broker can do in each agent. It depends on what
each agent's hooks allow; formats were checked against each agent's official
documentation on 2026-10-11 (Cursor again on 2026-10-17). End-to-end evidence is in [`bench/e2e/`](../bench/e2e/).

| | Claude Code | Codex CLI | Cursor (IDE) | OpenCode |
|---|---|---|---|---|
| Install | `zn hooks install claude-code` | `zn hooks install codex`, then trust in `/hooks` | `zn hooks install cursor` | `zn hooks install opencode` |
| Mechanism | Hooks (`settings.json`) | Hooks (`hooks.json`) | Hooks (`hooks.json`) | Plugin (`plugins/zn-gate.js`) |
| Block reads of `.env` with values, credential files, `~/.zn` | Yes (Read, Grep, LSP, shell) | Yes (shell, `apply_patch` into `~/.zn`) | Yes (file reads, shell) | Yes (all tools) |
| Block writes to `~/.zn` and to the agents' hook and plugin configuration | Yes (Write, Edit, shell) | Yes (`apply_patch`, checked file by file; shell) | **Best effort**: Write, Delete and Grep through `preToolUse`; shell through `beforeShellExecution` | Yes (write, edit, `apply_patch`, shell) |
| Scrub tool output before the model sees it | **Yes, every tool** (Bash, PowerShell, Read, Grep, LSP, WebFetch, MCP, MCP resources; Monitor through a streaming filter) | **Yes, lossy**: the result is replaced by its scrubbed text (Codex has no field that rewrites a result: `updatedMCPToolOutput` is listed as not supported; checked 2026-10-17) | **MCP output only**; shell and file output cannot be rewritten | **Yes, every tool** (and the TUI preview) |
| Block a pasted secret in the prompt | Yes | Yes | Yes | Yes (OpenCode shows it as an error) |
| Settings that turn zn's hooks off with no sign in the agent | `disableAllHooks` (yours or your organization's), and `allowManagedHooksOnly` in managed settings. `zn-gate check` and `zn hooks install` say so | `[features] hooks = false` (in your organization's `requirements.toml` or `managed_config.toml`, or in your `config.toml`), and `allow_managed_hooks_only` in `requirements.toml`. `zn-gate check` and `zn hooks install` say so | None in Cursor's documentation (checked 2026-10-17) | None in OpenCode's documentation (checked 2026-10-17) |
| If the zn hook cannot run (missing `node`, crash, timeout) | Tool calls run unchecked; errors inside zn deny the call or withhold the output. Prompts are blocked (`onFailure`, Claude Code 2.1.295 and later) | Codex does not document blocking here: the hook is reported as failed and calls and prompts run | Reads and prompts are blocked (`failClosed`); other events run unchecked | Calls and messages are blocked |
| Commands with `__ZN_<NAME>__`: through `zn run` | Rewritten automatically, shown to you for confirmation | The agent is told the exact `zn run -- …` line to use | The agent is told the exact `zn run -- …` line to use; Cursor asks you once wrapped | Rewritten automatically; OpenCode's own permission rules apply |
| Restore detected tokens into local commands and git-ignored files | Yes, shown in the confirmation dialog | No (tokens stay) | No (tokens stay) | No (tokens stay) |
| `secrets` MCP server | Yes (registered on install) | Yes (snippet printed) | Yes (snippet printed) | Yes (snippet printed) |
| Windows | Yes, including the PowerShell tool (Claude Code 2.1.299 or later: before it, without Git for Windows, `PreToolUse` let calls through when it could not run) | The hook command was run by hand from PowerShell and from cmd.exe (not in CI) | Not tested | Not tested (wrapping is written for bash) |
| End-to-end run, 0 values sent to the provider | **Yes** | **Yes** | Not run (no CLI with hooks to drive) | **Yes** |

zn's two MCP servers (`zn mcp` and the `secrets` server) speak MCP protocol version `2024-11-05` and answer
with it whatever version the client asks for, as the protocol allows; the client then uses that version.
Checked on 2026-10-17 with Claude Code 2.1.302 (`claude mcp list`: both connected) and with the official
TypeScript MCP SDK client whose newest version is `2025-11-25` (both servers connect and list their tools).

In every agent, a shell command longer than 100 KB (counted in characters; this
includes PowerShell and Claude Code's Monitor tool) is blocked, because zn
could not check it within the time the agent waits for the hook. The same
limit applies to a patch (`apply_patch`) in Codex and OpenCode.

## Skills, commands and @file in Claude Code

- **Typed skills and commands**: `UserPromptSubmit` sees only what you typed, not
  what a skill or command expands into. zn also registers a `UserPromptExpansion`
  hook, which checks the expanded text with the same detectors as a typed prompt
  and refuses the expansion when it contains a secret value, a private key or
  the lines of a `.env` file. It says why and what to do next. If the hook
  cannot run or takes too long, the expansion is blocked, like the other prompt
  hook. Expanded text over 1 MB is blocked because it cannot be checked in time.
  The hook needs a Claude Code version that has the `UserPromptExpansion` event
  (builds from about 2.1.141 on; 2.1.110 does not have it). With the plugin, an older
  Claude Code that does not know the event can ignore every hook in the plugin's
  `hooks.json`, so zn's plugin needs Claude Code 2.1.295 or later.
  The hook cannot rewrite the text, so there is no redaction here: the command
  is stopped and you remove the value or save it with `zn secret set`.
- **`!` shell commands inside skills and commands**: Claude Code checks them
  against your permission rules. zn does not confirm that its `PreToolUse` hook
  sees them. To turn them off, set `disableSkillShellExecution: true` in your
  Claude Code settings (in managed settings for a team).
- **`@file` mentions**: Claude Code does not run Read hooks for them, so zn
  cannot check the file when you mention it with `@`. A protected file
  (`.env`, credentials, a private key) is covered only when a tool call reads it.

## Codex CLI hook events

The table lists every Codex hook event named in the official hooks documentation
(learn.chatgpt.com/docs/hooks, checked 2026-10-18; the same event names appear in
openai/codex's generated hook schemas). It says which ones zn installs and why.
The Codex CLI version it was run on is given only where a check was run; that
check used Codex CLI 0.163.0. Rows marked "not tested" are from the documentation
only and have not been run against a live Codex.

| Event | zn uses it | What it does for zn |
|---|---|---|
| `PreToolUse` | Yes, matcher `^(Bash\|apply_patch\|mcp__.+)$` | Checks shell commands, patches and MCP call arguments before they run, and denies with zn's reason. Exit code 2 also blocks (documented). zn never answers `allow`. Shell and `apply_patch` checked on 0.163.0; MCP calls not tested. |
| `PostToolUse` | Yes, matcher `.*` | Scrubs tool output. Its `decision: "block"` replaces the result with zn's scrubbed copy. Checked on 0.163.0. |
| `PermissionRequest` | Yes, deny only | Runs the same check as `PreToolUse` when Codex is about to ask you to approve a call. zn answers `deny` with its reason and never `allow`. Not tested. |
| `UserPromptSubmit` | Yes | Blocks a secret pasted into the prompt. Checked on 0.163.0. |
| `SessionStart` | No | zn installs no session-start hook for Codex. |
| `Stop` | Yes, warn by default | Reviews the model's final answer for a secret value, or for a `__ZN_` placeholder that zn did not see earlier in the session. It warns with `systemMessage`, which you see and the model does not. It blocks, with a reason for the model to rewrite the answer, only with `"stopReview": "block"` under `hooks` in `~/.zn/config.json`; it never blocks when Codex is already continuing because of a Stop hook. Not tested. |
| `SubagentStart` | No | Not used. |
| `SubagentStop` | No | Not used. |
| `PreCompact` | No | Not used. |
| `PostCompact` | No | Not used. |
| `SessionEnd` | No | Not used. |
| `Interrupt` | No | Not used. The documentation lists it with no matcher. |

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
  - MCP tool calls reach `PreToolUse` (matcher `^(Bash|apply_patch|mcp__.+)$`), and zn checks
    their arguments for secret values and `__ZN_` markers, as it does for Cursor. Installs made
    before this change keep the old matcher until you run `zn hooks install codex` again, and
    Codex asks you to review the changed hook in `/hooks`. Only zn's own `secrets` server, as
    set in `config.toml` (your own or the project's `.codex/config.toml`), may receive
    placeholders. Known limit: a server set on the Codex command line with `-c mcp_servers.secrets...`
    or in a profile is not visible to the hook, so it gets no exception.
  - Approval prompts (`PermissionRequest`, same matcher as PreToolUse): when Codex is about to ask you
    to approve a shell command, a patch or an MCP call, zn runs the same check as before the call. If zn
    would deny it, the request is denied with zn's reason, so no Approve button is shown for it. zn never
    answers Allow there; for every other call it gives no answer, and the approval prompt stays. Installs
    made before this change get the new hook when you run `zn hooks install codex` again, and Codex asks
    you to review it in `/hooks`.
  - Final answers (`Stop`): zn only warns, and the warning does not reach the model. To
    have Codex ask the model to rewrite an answer that contains a secret value, set
    `"stopReview": "block"` under `hooks` in `~/.zn/config.json`. zn blocks at most once
    per answer and never when the answer is already a continuation. Installs made before
    this change get the new hook when you run `zn hooks install codex` again, and Codex
    asks you to review it in `/hooks`.
    To tell whether a placeholder came from a tool, zn reads the session transcript in
    pieces of 256 KB and stops as soon as it finds the placeholder earlier in the session. A transcript larger than 64 MB is not read, so
    that check is skipped for it. A final answer with nothing to report prints nothing and
    exits with code 0, which Codex reads as success. A problem inside zn while it checks an
    answer also exits with code 0 and prints a warning, never code 2, because code 2 would
    make Codex continue the answer.
  - Checked with Codex CLI 0.163.0 on 2026-10-16: the shell tool (`exec_command`
    inside Codex) reaches hooks as `tool_name: "Bash"`, with the command in
    `tool_input.command`. zn's `PreToolUse` hook blocked `cat .env` and allowed
    an ordinary file, and `PostToolUse` and `UserPromptSubmit` ran as expected.
    New or changed hooks run only after you trust them in `/hooks`
    (`codex exec --dangerously-bypass-hook-trust` skips that for one run, for
    automation that already checks its hooks).
  - `apply_patch` with a local model (Codex CLI 0.163.0, 2026-10-16): Codex offers its
    `apply_patch` tool only to the models in its own catalog, so a local model cannot use
    it; zn checks that tool from its payload (`apply_patch` in the hook matcher, file by
    file). A model that sends `apply_patch` as a shell command reaches zn as `Bash`, and zn
    refuses it: its `***` lines read as file patterns that can match secret files, and the
    message names the file when the patch writes to one such as `.env`. Known difference:
    the `apply_patch` tool may edit `.env` (writes are checked only for `~/.zn` and agent
    settings), while any patch sent as a shell command is refused.
- **Settings that turn hooks off.** zn reads the settings files only: the managed settings of Claude Code (`managed-settings.json` and `managed-settings.d/` in `/etc/claude-code`, `/Library/Application Support/ClaudeCode` or `C:\Program Files\ClaudeCode`) and of Codex (`requirements.toml` and `managed_config.toml` in `/etc/codex`, or `requirements.toml` in `%ProgramData%\OpenAI\Codex` and `managed_config.toml` in your Codex folder on Windows), and your own settings. A policy sent through MDM or the agent's cloud is not seen. When such a setting stops every hook, zn's start-of-session hook does not run either (zn installs no session-start hook for Codex), so `zn-gate check` is where you see it.
- **Cursor** (best effort: its hook documentation leaves the input of some
  tools open, and zn fails closed where it cannot read a path):
  - `beforeReadFile` can only allow or deny. zn sets `failClosed: true` on it
    and on `beforeSubmitPrompt`, so a hook that crashes or times out blocks the
    read or the prompt.
  - `beforeMCPExecution` denies an MCP call whose arguments carry a
    `__ZN_<NAME>__` marker or a secret value, and names the kind of secret,
    never its value. The one exception for markers is zn's own `secrets`
    server, identified by the exact command `zn hooks install` writes; a
    server reached by URL, or one that only has the name, is not zn's own.
    Arguments over 1 MB (counted in characters) are denied, because zn cannot
    check them. Other calls get no answer, so Cursor's own MCP approval still
    applies. This hook, like
    `beforeShellExecution` and `preToolUse`, has no `failClosed`: zn gives no
    answer when it has no objection, and Cursor treats an empty answer as a
    block when `failClosed` is set, which would block every such call. The
    trade-off: if this hook crashes or times out, the call runs unchecked.
  - `preToolUse` (Write, Delete, Grep) checks the file a call names with the
    same rules as the other tools. Cursor does not document the input keys of
    these tools, so zn looks for the usual names (`file_path`, `path`,
    `target_file`). A write whose file cannot be read is refused.
  - A call zn has no objection to gets no answer, not `allow`: an `allow` could
    skip Cursor's own confirmations. A Grep without a `path` searches the whole
    workspace, so files that zn would shadow or refuse can be found that way;
    zn does not filter those results.
  - `postToolUse` can only replace the output of MCP tools. Checked again on
    2026-10-17: no Cursor hook can change shell or file output before the model
    sees it. `afterShellExecution` receives the output but returns nothing,
    there is no hook after a file read (`beforeReadFile` can only allow or deny),
    and `additional_context` from `postToolUse` is added after a result instead
    of replacing it.
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

## zn Team policy choices by zn-gate version

The organization policy sets one choice per rule: Not blocked, Warn or Block
(details in [team.md](team.md#the-three-choices-not-blocked-warn-block)).

| zn-gate version | Block (`deny`) | Warn (`warn`) |
|---|---|---|
| 1.6.0 to 1.7.x | Yes | No. The zn service removes the `warn` field: the rule's other limits still apply, but there is no notice and no `warn` record. |
| 1.8.0 and later | Yes | Yes |

zn-gate tells the server on each policy download which policy features it
understands, so `warn` rules are sent only to 1.8.0 and later.

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

## If your agent blocks every prompt

When zn's hook cannot run, Claude Code 2.1.295 or later (with the zn-gate plugin or `zn hooks install`), Cursor and OpenCode block
prompts instead of letting them through unchecked (see the table above). This usually happens after Node.js is
upgraded, moved or removed (for example with nvm), because the hook command points to the old one. Codex CLI lets
prompts through in that case. To fix it, in your own terminal:

1. Run `npx -y zn-gate check`. It names each agent that is not protected and the command that fixes it.
2. Usually that is `npm install -g zn-gate`, then `zn hooks install <agent>`. With the zn-gate plugin for Claude Code,
   start a new Claude Code session after fixing Node.js.
3. If you need your agent right away, turn zn off for it until you have fixed it: `npx -y zn-gate hooks uninstall <agent>`
   (the `zn` command may be gone with the old Node.js), or `claude plugin disable zn-gate@usezn` for the plugin (or `/plugin`
   inside Claude Code). Turn it back on with `zn hooks install <agent>` or `claude plugin enable zn-gate@usezn`, then run
   `zn-gate check` again.

## Limits that apply to every agent

- **An event zn cannot read is refused.** Empty stdin, or stdin that is not
  JSON, exits with code 2 and the reason on stderr. Claude Code and Codex block
  the call on exit code 2; Cursor also gets its deny answer. Setting
  `whenUnavailable` to `"allow"` in `~/.zn/config.json` lets such events pass.
  The Codex `Stop` event is the exception: zn never blocks it, because exit code 2 would
  make Codex continue the answer. It reports the problem on stderr, and a failure inside
  zn prints a warning instead.

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
