# Agent compatibility

What the secrets scrubber and broker can do in each agent. zn-gate is not a sandbox: what it covers
depends on what each agent's hooks can see and block; formats were checked against each agent's official
documentation on 2026-10-11 (Cursor again on 2026-10-17). End-to-end evidence is in [`bench/e2e/`](../bench/e2e/).

| | Claude Code | Codex CLI | Cursor (IDE) | OpenCode | Antigravity |
|---|---|---|---|---|---|
| Install | `zn hooks install claude-code` | `zn hooks install codex`, then trust in `/hooks` | `zn hooks install cursor` | `zn hooks install opencode` | `zn hooks install antigravity` |
| Mechanism | Hooks (`settings.json`) | Hooks (`hooks.json`) | Hooks (`hooks.json`) | Plugin (`plugins/zn-gate.js`) | Hooks (`hooks.json`) |
| Block reads of `.env` with values, credential files, `~/.zn` | Yes (Read, Grep, LSP, shell) | Yes (shell, `apply_patch` into `~/.zn`) | Yes (file reads, shell) | Yes (all tools) | Yes, by path (file tools and shell), once the hooks are installed |
| Block writes to `~/.zn` and to the agents' hook and plugin configuration | Yes (Write, Edit, shell) | Yes (`apply_patch`, checked file by file; shell) | **Best effort**: Write, Delete and Grep through `preToolUse`; shell through `beforeShellExecution` | Yes (write, edit, `apply_patch`, shell) | **Best effort**: the agent cannot edit the hook files and Antigravity's CLI settings file (three files); Antigravity's MCP configuration is not protected |
| Scrub tool output before the model sees it | **Yes, every tool** (Bash, PowerShell, Read, Grep, LSP, WebFetch, MCP, MCP resources; Monitor through a streaming filter) | **Yes, lossy**: the result is replaced by its scrubbed text (Codex has no field that rewrites a result: `updatedMCPToolOutput` is listed as not supported; checked 2026-10-17) | **MCP output only**; shell and file output cannot be rewritten | **Yes, every tool** (and the TUI preview) | **No**: Antigravity hooks cannot rewrite what a tool returns |
| Block a pasted secret in the prompt | Yes | Yes | Yes | Yes (OpenCode shows it as an error) | No |
| Check MCP tool calls before they run | **Yes** (matcher `^mcp__.*`): a secret value or `__ZN_` marker in the arguments is blocked, and personal data (email, phone, IBAN, card, national ID) asks you first | Secrets and markers: yes (blocked). Personal data: no prompt, because Codex hooks cannot ask | Secrets and markers: yes (blocked). Personal data: no prompt from zn (Cursor does not enforce a hook's ask for MCP calls; its own MCP approval applies) | No | Secrets and markers: yes (blocked). Personal data: zn asks you first. Paths in the arguments also get the read and write checks. MCP calls are recognized by a tool name that starts with `mcp` (Antigravity does not document MCP tool names) |
| Settings that turn zn's hooks off with no sign in the agent | `disableAllHooks` (yours or your organization's), and `allowManagedHooksOnly` in managed settings. `zn-gate check` and `zn hooks install` say so | `[features] hooks = false` (in your organization's `requirements.toml` or `managed_config.toml`, or in your `config.toml`), and `allow_managed_hooks_only` in `requirements.toml`. `zn-gate check` and `zn hooks install` say so | None in Cursor's documentation (checked 2026-10-17) | None in OpenCode's documentation (checked 2026-10-17) | `"enabled": false` on a hook (Antigravity: "Set to `false` to disable the hook without removing it"), in your hooks file or in a project's `.agents/hooks.json`. `zn-gate check` reports zn's hook as not protected when it is turned off, and `zn hooks install antigravity` turns it back on. Antigravity documents no organization setting that turns hooks off (checked 2026-10-23) |
| If the zn hook cannot run (missing `node`, crash, timeout) | Errors inside zn deny the call or withhold the output. If the hook cannot start (for example the Node.js it was installed with is gone, exit 127), Claude Code treats it as a non-blocking error and runs the call, so `zn hooks install claude-code` writes a small launcher script (`~/.zn/hooks/zn-hook-claude-code.sh`, run by `sh`, or Git Bash on Windows) as the hook command. It runs the Node.js it was installed with, else `zn` from your PATH, else it needs no Node.js to block: it exits 2 with the reason on `PreToolUse`, `UserPromptSubmit` and `UserPromptExpansion`, and on `PostToolUse` (the tool already ran) only warns you in the session. If the hook after a tool fails, that output reaches the model unscrubbed (Claude Code cannot hold back the output of a tool that already ran). The hooks also carry `onFailure: "block"` (Claude Code 2.1.295 and later). A hook that starts and then fails (any exit code other than 0 or 2) is blocked the same way. `zn-gate check` reports a launcher whose Node.js is gone. Hooks installed by an older zn-gate keep the plain command until you run `zn hooks install claude-code` again. The zn-gate plugin starts its hooks with the first `node` on the PATH of Claude Code; its `PreToolUse`, `UserPromptSubmit` and `UserPromptExpansion` hooks carry `onFailure: "block"`, so without `node` they block too (Claude Code 2.1.295 and later, which the plugin needs anyway) | Codex blocks only on a deny or on exit code 2; any other failure is reported as a hook failure and the call runs. While Node.js runs, zn blocks for itself on `PreToolUse`, `PermissionRequest` and `UserPromptSubmit`: if a check takes too long (it answers 5 seconds before Codex's 30-second limit) or fails, zn denies the call or prompt and exits with code 2. When the hook cannot start, `zn hooks install codex` writes a small launcher script (`~/.zn/hooks/zn-hook-codex.sh`) as the hook command. It runs the Node.js it was installed with, else `zn` from your PATH, else it needs no Node.js to block: it exits 2 with the reason on `PreToolUse` and `UserPromptSubmit`, denies on `PermissionRequest`, and on the other events only warns you in the session. On Windows the same steps are written inline in `commandWindows` (run by hand only, not on a live Windows Codex). A hook that starts and then fails (any exit code other than 0 or 2) is blocked the same way. `zn-gate check` reports a launcher whose Node.js is gone. Hooks installed by an older zn-gate keep the plain command until you run `zn hooks install codex` again | Cursor treats a failing hook as fail-open ("Other exit codes - Hook failed, action proceeds"); `failClosed` blocks, and so does exit code 2. Reads and prompts are blocked (`failClosed`). `zn hooks install cursor` also writes a small launcher script (`~/.zn/hooks/zn-hook-cursor.sh`) as the hook command: it runs the Node.js it was installed with, else `zn` from your PATH, else it needs no Node.js to block: it exits 2 on shell commands, MCP calls, file reads, prompts and `preToolUse`, and after a tool has run only warns you. On Windows the same steps are written inline in each hook command, and there a block is the deny answer with exit code 0 (a nested PowerShell turns exit code 2 into 1). A hook that starts and then fails (any exit code other than 0 or 2) is blocked the same way. `zn-gate check` reports a launcher whose Node.js is gone. Hooks installed by an older zn-gate keep the plain command until you run `zn hooks install cursor` again | Calls and messages are blocked | Antigravity does not document what happens when a hook fails; in our tests (October 2026) the action is blocked. `zn hooks install antigravity` writes a launcher script (`~/.zn/hooks/zn-hook-antigravity.sh`) that answers a deny with the repair step when the Node.js is gone, and a project install (`--project`) wraps `zn hook antigravity` the same way (`sh -c`, PowerShell on Windows), so a missing `zn` or `node` ends in that deny too. zn itself answers a deny when a check hangs or fails. `zn-gate check` reports a launcher that cannot start |
| Commands with `__ZN_<NAME>__`: through `zn run` | Rewritten automatically, shown to you for confirmation | The agent is told the exact `zn run -- …` line to use | The agent is told the exact `zn run -- …` line to use; Cursor asks you once wrapped | Rewritten automatically; OpenCode's own permission rules apply | The agent is told the exact `zn run -- …` line to use |
| Restore detected tokens into local commands and git-ignored files | Yes, shown in the confirmation dialog | No (tokens stay) | No (tokens stay) | No (tokens stay) | No (tokens stay) |
| `secrets` MCP server | Yes (registered on install) | Yes (snippet printed) | Yes (snippet printed) | Yes (snippet printed) | Not installed by the hooks; you can add the MCP server (see the [Antigravity page](editors/antigravity.md)) |
| Windows | Yes, including the PowerShell tool (Claude Code 2.1.299 or later: before it, without Git for Windows, `PreToolUse` let calls through when it could not run) | The hook command was run by hand from PowerShell and from cmd.exe. The end-to-end run also passed on Windows Server 2022 with Codex 0.163.0 and PowerShell, 0 values sent to the provider ([evidence](../bench/e2e/windows/); one run, not in CI) | Not tested | End-to-end run on Windows Server 2022 with OpenCode 1.19.3 ([evidence](../bench/e2e/windows/); one run, not in CI), 0 values sent to the provider. With PowerShell, OpenCode's default shell there, a command with a marker failed instead of running in that run (the wrapping was then written for bash only; the PowerShell wrapping added since is covered by unit tests but not re-run end to end); with Git Bash (`SHELL` set) it runs | Checked by hand on a real Windows machine with the Antigravity IDE and CLI (October 2026); no automated end-to-end run |
| End-to-end run, 0 values sent to the provider | **Yes** | **Yes** | Not run (no CLI with hooks to drive) | **Yes** | Not run |

Tool output is checked within fixed limits so that the check always finishes before the agent's own hook
timeout: 8 MiB of text and 1,000 different secret values per output, and 32 MiB of the event read from
stdin, with a deadline of the agent's hook timeout minus 5 seconds. What zn cannot check in time is replaced
by a short notice ("output withheld because it is too large to check for secrets in time") and the agent is
told to ask for a smaller output (a line range, grep, head or tail). Output that is mostly invisible characters
is shown without them, with its secrets redacted. See
[Failure behaviour](threat-model.md#failure-behaviour) for the details and the one known limit.

zn's two MCP servers (`zn mcp` and the `secrets` server) support MCP protocol versions `2025-11-25`,
`2025-06-18`, `2025-03-26` and `2024-11-05`. They answer initialize with the version the client asks for, or with
`2025-11-25` if the client asks for one they do not know (the client then decides). Tool annotations are sent from
`2025-03-26`, tool titles from `2025-06-18`, JSON-RPC batches are accepted only in `2025-03-26` (added there, removed in `2025-06-18`), and an unknown tool is error `-32602` from `2025-06-18` on (`-32601` before).
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
- **MCP tool calls**: zn's `PreToolUse` hook runs for every MCP tool (matcher
  `^(Bash|PowerShell|Monitor|Read|Grep|LSP|Edit|MultiEdit|Write|NotebookEdit|WebFetch)$|^mcp__.*`) and
  checks the call's arguments before it runs. A secret value (stored or recognised) or a `__ZN_`
  marker is blocked with a reason that names the kind. Personal data (email address, phone number,
  IBAN, card, national ID, and an IP address if you turned it on) is not blocked: Claude Code asks you to
  approve the call, and the message names the kind and the server, so you can allow a CRM or a mail
  server to receive it. A secret in the same call wins over personal data (blocked, not asked). Calls
  to zn's own vault server (`secrets_http_request` with a `__ZN_` marker) are allowed: zn checks your
  Claude Code MCP configuration to see that the server is zn's own, and a server that only has the same name
  (for example one defined in a project's `.mcp.json`) is checked like any other. The zn-gate plugin's
  detector server is not asked about personal data. Hooks installed by an earlier zn-gate keep the old
  matcher, which skips MCP tools, until you run `zn hooks install claude-code` again.
- **`@file` mentions**: Claude Code does not run Read hooks for them, so zn
  cannot check the file when you mention it with `@`. A protected file
  (`.env`, credentials, a private key) is covered only when a tool call reads it.

## Codex CLI hook events

The table lists every Codex hook event named in the official hooks documentation
(learn.chatgpt.com/docs/hooks, checked 2026-10-18; the same event names appear in
openai/codex's generated hook schemas). It says which ones zn installs and why.
The Codex CLI version it was run on is given only where a check was run; that
check used Codex CLI 0.163.0. The runs are in `bench/e2e/codex/scenarios/`: they use a scripted
model provider on 127.0.0.1, so no account or key is needed, and every value is fake. Rows marked
"not tested" are from the documentation only and have not been run against a live Codex.

| Event | zn uses it | What it does for zn |
|---|---|---|
| `PreToolUse` | Yes, matcher `^(Bash\|apply_patch\|mcp__.+)$` | Checks shell commands, patches and MCP call arguments before they run, and denies with zn's reason. Exit code 2 also blocks (documented). zn never answers `allow`. Shell, `apply_patch` and MCP calls checked on 0.163.0: a placeholder or a secret value in the arguments is denied and never reaches the server. |
| `PostToolUse` | Yes, matcher `.*` | Scrubs tool output. Its `decision: "block"` replaces the result with zn's scrubbed copy. Checked on 0.163.0. Opt-in `replaceToolOutputOnSecret` also sends `continue: false` with a `stopReason` for a real secret value. Checked on 0.163.0: the model still gets the scrubbed copy, not the stop text, and the turn goes on; see below. |
| `PermissionRequest` | Yes, deny only | Runs the same check as `PreToolUse` when Codex is about to ask you to approve a call. zn answers `deny` with its reason and never `allow`. Checked on 0.163.0 in the terminal UI: `codex exec` never asks for approval, so the event does not run there. |
| `UserPromptSubmit` | Yes | Blocks a secret pasted into the prompt. Checked on 0.163.0. |
| `SessionStart` | Yes, context only | Adds a short reminder for the model through `additionalContext`: zn protects `.env` files and the vault, and `zn run` runs a command that needs a secret. It checks nothing and never stops the session. Checked on 0.163.0: the reminder is in the first request the model gets. |
| `Stop` | Yes, warn by default | Reviews the model's final answer for a secret value, or for a `__ZN_` placeholder that zn did not see earlier in the session. It warns with `systemMessage`, which you see and the model does not. It blocks, with a reason for the model to rewrite the answer, only with `"stopReview": "block"` under `hooks` in `~/.zn/config.json`; it never blocks when Codex is already continuing because of a Stop hook. Codex 0.163.0 writes each final answer to its session log three times, so zn counts every copy of the answer before it decides that a placeholder is unseen. |
| `SubagentStart` | Yes, context only | The same reminder, for a subagent the model starts with `spawn_agent`. Checked on 0.163.0 with the `multi_agent` feature on: the hook runs, the subagent's model gets the reminder, and the subagent's own tool calls go through zn's `PreToolUse` check (a read of `~/.aws/credentials` by the subagent was denied). Not checked: the `multi_agent_v2` tool. |
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
  The output of web fetches, MCP tools and shell commands is also checked
  with the local rules: when they flag text that reads like instructions to
  the agent, zn adds a note (`additionalContext`) telling the agent to treat
  it as data and to tell you. The output is not blocked for this. Turn it off
  with `{"hooks": {"checkToolOutputInstructions": false}}` in
  `~/.zn/config.json`. At most 64 KiB of each output are checked: the first 48 KiB and
  the last 16 KiB.
- **Codex CLI**:
  - Rewriting a call (`updatedInput`) is only accepted together with `allow`,
    which would skip your approval policy, and `ask` is not supported. So zn
    denies the call and tells the agent the exact `zn run` command. Once the
    agent uses it, Codex's approval policy applies.
  - PostToolUse cannot rewrite output; `decision: "block"` replaces the result
    with zn's scrubbed copy. The model gets text instead of the structured
    result.
  - Opt-in (`replaceToolOutputOnSecret`, off by default): set `{"hooks": {"replaceToolOutputOnSecret": true}}` in
    `~/.zn/config.json`. When a tool output holds a real secret value (not only a `__ZN_` marker), zn also
    returns `continue: false` with a `stopReason` that names the kind of secret, never the value. Codex's docs
    say it then replaces the tool result with that stop text and carries on. This does not end the turn on
    its own. Checked on Codex CLI 0.163.0: the model still gets the tokenized copy of the output and the turn
    goes on; the stop text is not what the model sees. Markers alone change nothing. Environment variables
    do not turn it on.
  - Codex's own session log keeps the original output.
  - Another tool's `PreToolUse` hook that answers `allow` with `updatedInput` changes the command Codex
    runs, and zn does not see the change: its `PreToolUse` check gets the original command. Checked on
    Codex CLI 0.163.0 with a stand-in hook that turned a harmless `echo` into a read of a credentials file:
    the read ran, and zn's `PostToolUse` check still replaced the secret values in the output before the
    model saw them. Do not install another hook that rewrites commands next to zn's.
  - Hooks are a guardrail, not an enforcement boundary (Codex's own words).
  - **Other tools' hooks (Codex).** Codex runs every matching `PreToolUse` hook at the same time, each with the
    original call. A hook from another tool can answer "allow" with a changed command, and Codex then runs the
    changed command, which zn did not check before it ran. A hook that answers a `PermissionRequest` with "allow"
    can also remove an approval prompt. zn cannot see what another hook does. `zn-gate check` reports Codex as
    not fully protected when your Codex folder (`hooks.json` or `config.toml`) or the project's `.codex` folder
    holds another `PreToolUse` or `PermissionRequest` hook that is not zn's and does not run in the
    background; review it and remove it if you do not need it. After the command has run, zn's
    `PostToolUse` hook sees the command that really ran: it still hides secret values in the output, and
    it withholds the output when that command is one zn blocks. It cannot undo what the command did, and
    it does not read hooks that a plugin or your organization sets.
  - MCP tool calls reach `PreToolUse` (matcher `^(Bash|apply_patch|mcp__.+)$`), and zn checks
    their arguments for secret values and `__ZN_` markers, as it does for Cursor. Installs made
    before this change keep the old matcher until you update them
    (see [upgrading.md](upgrading.md)). Only zn's own `secrets` server, as
    set in `config.toml` (your own or the project's `.codex/config.toml`), may receive
    placeholders. Known limit: a server set on the Codex command line with `-c mcp_servers.secrets...`
    or in a profile is not visible to the hook, so it gets no exception.
  - Approval prompts (`PermissionRequest`, same matcher as PreToolUse): when Codex is about to ask you
    to approve a shell command, a patch or an MCP call, zn runs the same check as before the call. If zn
    would deny it, the request is denied with zn's reason, so no Approve button is shown for it. zn never
    answers Allow there; for every other call it gives no answer, and the approval prompt stays. Installs
    made before this change get the new hook when you update them (see [upgrading.md](upgrading.md)).
  - Final answers (`Stop`): zn only warns, and the warning does not reach the model. To
    have Codex ask the model to rewrite an answer that contains a secret value, set
    `"stopReview": "block"` under `hooks` in `~/.zn/config.json`. zn blocks at most once
    per answer and never when the answer is already a continuation. Installs made before
    this change get the new hook when you update them (see [upgrading.md](upgrading.md)).
    To tell whether a placeholder came from a tool, zn reads the session transcript in
    pieces of 256 KB, counts every copy of the final answer (Codex writes it to the log three times) and finds out whether the placeholder
    appears anywhere else. A transcript larger than 64 MB is not read, so
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
- **Background hooks (Codex).** A Codex hook with `async` set runs in the background and cannot block a call or change a result. If zn's hook is set that way in `hooks.json` or `config.toml` in your Codex folder, `zn-gate check` reports Codex as not protected; remove `async` from zn's hook.
- **Trust and updates (Codex).** Installing zn-gate as a Codex plugin would not skip the `/hooks` review: Codex ignores a plugin's hooks until you review and trust them, and it asks again after every plugin update. zn installs its hooks with `zn hooks install codex` instead, and you trust them in `/hooks`.
- **Ways Codex turns zn's hooks off.** `async`, a `[hooks.state]` entry with `enabled = false` for one of zn's hooks, `[features] hooks = false`, and `allow_managed_hooks_only = true` in your organization's requirements (when zn's hooks are not among the managed ones) each stop zn's hooks from protecting anything, and Codex says nothing. `zn-gate check` reports all four as not protected and says what to change. It reads `hooks.state` only in your own `config.toml`; a setting passed on the Codex command line with `-c` is not seen. The Python package has no `check` command.
- **Settings that turn hooks off.** zn reads the settings files only: the managed settings of Claude Code (`managed-settings.json` and `managed-settings.d/` in `/etc/claude-code`, `/Library/Application Support/ClaudeCode` or `C:\Program Files\ClaudeCode`) and of Codex (`requirements.toml` and `managed_config.toml` in `/etc/codex`, or `requirements.toml` in `%ProgramData%\OpenAI\Codex` and `managed_config.toml` in your Codex folder on Windows), the enterprise `hooks.json` of Cursor (`/etc/cursor/hooks.json`, `/Library/Application Support/Cursor/hooks.json` or `C:\ProgramData\Cursor\hooks.json`), and your own settings. zn also recognises its own hooks in those same managed files (Cursor: the enterprise `hooks.json`; Codex: `[[hooks.<Event>]]` in `requirements.toml`), so `zn-gate check` and `zn-gate status` report an agent set up by your administrator as installed (managed) and name the file. A policy sent through MDM or the agent's cloud is not seen. When such a setting stops every hook, the session-start reminder that zn adds for Codex does not appear either, so `zn-gate check` is where you see it. Cursor runs the hooks of every source, so its enterprise file cannot turn zn's hooks off; zn only warns when zn's hook there lacks `failClosed` on `beforeReadFile` or `beforeSubmitPrompt`, or when the file has hooks without zn's. Hooks set in Cursor's team dashboard are not seen.
- **Copilot CLI** (experimental: `zn hooks install copilot [--project]`;
  `zn-gate check` and `zn-gate init` list it as "Copilot CLI (experimental)").
  Covered: `preToolUse` blocks reads and writes of secret files by path,
  shell commands that handle secrets, and edits of Copilot's own hook and
  settings files; `postToolUse` replaces secret values in the results of
  read-type and shell tools (successful results only). zn writes its own
  `zn-gate.json` in `~/.copilot/hooks/` (or `$COPILOT_HOME/hooks/` when you set
  a custom Copilot folder) and, with `--project`, in `.github/hooks/`. Checked
  end to end with Copilot CLI 1.0.98 against a scripted model provider: 0 secret
  values sent. Not covered, and limits:
  - Copilot's `userPromptSubmitted` hook cannot block or rewrite a typed
    prompt, so a pasted secret is not blocked.
  - A hook that takes longer than its timeout lets the call through (Copilot
    fails open there). Machine policy hooks in `/etc/github-copilot/policy.d`
    run in addition and are not seen by zn.
  - MCP tools Copilot does not name as read or shell tools are not checked and
    their output is not scrubbed. The docs do not list the argument names of
    each tool, so zn refuses a known tool whose arguments it cannot read.
  - Not tested on Windows.
  - Copilot's own session log (`events.jsonl`) keeps the original tool output
    on your machine.
  - `disableAllHooks` in zn's file or in `.github/copilot/settings(.local).json`
    turns the hooks off; `zn-gate check` reports it.
- **Gemini CLI** (experimental: `zn hooks install gemini [--project]`;
  `zn-gate check` lists it as "Gemini CLI"). Google replaced Gemini CLI with Antigravity CLI for free and Google One accounts on 18 June 2026; Gemini CLI keeps working with zn-gate.
  Covered: `BeforeTool` blocks reads and writes of secret files by path, shell
  commands that handle secrets, and edits of Gemini CLI's own settings files.
  zn adds its hook to `~/.gemini/settings.json` (or `.gemini/settings.json`
  with `--project`). Checked end to end with Gemini CLI 0.64.0 against a
  scripted model provider. Not covered, and limits:
  - What a tool returns is not changed: zn does not use `AfterTool`, so a
    value printed by a command or a file the agent may read reaches the model.
    Keep secrets in the vault.
  - Gemini CLI hooks cannot ask you for confirmation, so zn blocks only what
    it would refuse and says nothing otherwise (Gemini CLI's own approval
    applies). A pasted secret in a typed prompt is not checked.
  - A hook that crashes or times out does not block the call: only an explicit
    refusal (exit code 2) does. A user install goes through a small launcher
    script that blocks the call if the Node.js zn was installed with is gone.
  - A project hook stays untrusted until you approve it in Gemini CLI, and it
    runs `zn` from your PATH, so every teammate needs zn-gate installed.
  - `hooksConfig.enabled: false`, a name in `hooksConfig.disabled` or
    `/hooks disable` turn the hook off; `zn-gate check` reports them.
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
    trade-off: if this hook crashes or times out, the call runs unchecked. (If it cannot start
    because its Node.js is gone, the launcher script described above blocks the call.)
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
  - On Windows, OpenCode's command tool runs in PowerShell unless the `SHELL`
    environment variable names another shell (measured with OpenCode 1.19.3 on
    Windows Server 2022: with `SHELL` unset it used PowerShell, and with `SHELL`
    set to Git Bash it used Git Bash). zn follows the same rule. When `SHELL` is
    unset, or names anything other than a bash-like shell (`bash`, `sh`, `zsh`),
    zn checks and wraps the command as PowerShell, the way it does for Claude
    Code's PowerShell tool: the command must be one program with plain arguments
    (no pipeline, variable or script block), and zn says so when it is not. When
    `SHELL` names a bash-like shell, such as Git Bash, commands are wrapped for
    bash as before. On macOS and Linux only an explicit `powershell` or `pwsh`
    in `SHELL` selects the PowerShell form. The plugin sends zn only the shell's
    program name (never its path) and the platform.

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
files, because the hook command runs zn from PATH. Claude Code 2.1.295 or later
then blocks tool calls and prompts (the hooks are set to block when they cannot
run); older Claude Code versions and Codex let the call go ahead. Cursor blocks
file reads and prompts (those hooks fail closed) and lets the other calls go
ahead; OpenCode blocks calls and messages. In Claude Code, Codex and Cursor, the
output of a tool that already ran reaches the model without zn's cleaning,
because the hook that runs after a tool cannot block it; OpenCode withholds that
output.
Install zn on every machine that runs the agent.

## If your agent blocks every prompt

When zn's hook cannot run, Claude Code 2.1.295 or later (with the zn-gate plugin or `zn hooks install`), Cursor and OpenCode block
prompts instead of letting them through unchecked (see the table above). Codex CLI lets prompts through in that case.
This usually happens after Node.js is upgraded, moved or removed (for example with nvm). The fix, step by step
(`npx -y zn-gate check`, then `npm install -g zn-gate` and `zn hooks install <agent>`, or turning zn off for that agent
until it is fixed), is in [upgrading.md](upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew).

## Antigravity when its hook cannot start

Antigravity does not document what it does when a hook cannot run. What we observed in our own tests (Windows, Antigravity IDE and CLI, 2026-10-20): a PreToolUse hook that cannot start, prints nothing, prints text that is not JSON, or prints `{}` makes Antigravity deny every tool call, with an empty reason, so a broken zn hook stops the agent instead of letting calls run unchecked. Not tested: a hook that times out, and organization settings that turn hooks off (none is documented). zn fails closed too: it prints an explicit allow or deny for every event, an internal error becomes a deny with a plain reason, and a check that has not finished 5 seconds before the hook's timeout is answered with a deny. `zn hooks install antigravity` starts the hook once with a harmless test event and reports if it does not answer with a valid decision. Antigravity runs file searches through the shell, so zn checks them as commands (see [the Antigravity page](editors/antigravity.md)).

Other hooks: Antigravity documents `allow` as "delegating to the next hook or default policy", but not in which order hooks run, which answer wins when they disagree, or how hooks from a CLI plugin (a plugin's own `hooks.json`) rank against yours. So zn cannot promise that its deny holds against another hook that runs for the same tool call. `zn-gate check` lists other enabled `PreToolUse` hooks in your hooks file and in the project's `.agents/hooks.json` as a note; it cannot see plugin hooks.

Without help, a hook that cannot start would block the tool call with no message from zn, or let it run. So `zn hooks install antigravity` writes a small launcher script (`~/.zn/hooks/zn-hook-antigravity.sh`, run by `sh`) as the user hook command; on Windows the same steps are written inline as a PowerShell command. The launcher runs the Node.js zn-gate was installed with, else `zn` from your PATH, and if neither can start it needs no Node.js to answer Antigravity's deny format, `{"decision":"deny","reason":"..."}`, with the repair step: install zn-gate (`npm install -g zn-gate`) and run `zn hooks install antigravity` again. A hook that starts and then fails is answered with a deny too (run `zn-gate check` to see why). `zn-gate check` reports a launcher whose Node.js is gone. A project install (`--project`) cannot name this machine's launcher, because `.agents/hooks.json` is shared through the repository. It writes `zn hook antigravity` inside a one-line guard instead (`sh -c` on macOS and Linux, an encoded PowerShell command on Windows): if `zn` or `node` is not on the PATH, or zn fails after it starts, the guard prints the same deny with the repair step (`npm install -g zn-gate`). The command is written for the kind of machine that ran the install, so a teammate on the other kind runs `zn hooks install antigravity --project` in their own copy of the project. The launcher path is written without quotes, because Antigravity runs the command without a shell and a quote would become part of the file name. For the same reason the launcher path cannot contain a space: if your home folder has one (for example `/Users/Jose Perez`), `zn hooks install antigravity` stops with a message instead of writing a hook that never starts, and `zn-gate check` does not report such a hook as working. Choose a folder that you own, whose path has no spaces, and run `ZN_HOOK_DIR=<that folder> zn hooks install antigravity`. zn-gate uses that folder only if the path has no link and the folder and every folder above it (up to `/`) is owned by you or by root and has no write for group or others, with no exception for the sticky bit (so `/tmp` and shared folders are refused), because the launcher it holds runs on every tool call; otherwise it refuses, before writing anything, and says why. On Windows the Antigravity hook is written inline and does not use `ZN_HOOK_DIR`. Hooks installed by an older zn-gate (the plain command, or the launcher path in quotes) do not start in Antigravity: `zn-gate check` says so, and `zn hooks install antigravity` fixes it.

## Agent memory and instruction files

Agents read some files at the start of every session as standing instructions or memory. Text written there outlives the session, so zn asks before the agent writes to them: `MEMORY.md`, `SOUL.md`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.cursor/rules/*`, `.github/copilot-instructions.md` and Claude Code's memory folders (`~/.claude/projects/*/memory/*`). Reading them is always allowed. The message names the file and says to approve only if you asked for the change.

What counts as a write: the file tools (Write, Edit, MultiEdit, NotebookEdit and their equivalents), a shell redirection (`>`, `>>`), `tee`, `cp`, `mv`, `install`, `rsync`, `dd of=`, `touch`, `truncate`, an in-place `sed -i` or `perl -i`, a download saved with `curl -o` / `--output` or `wget -O` / `--output-document`, and the PowerShell writers (`Set-Content`, `Add-Content`, `Out-File`, `Copy-Item`, `Move-Item`). Only the command word counts, after `sudo`, `env`, `nohup`, `time`, `xargs` and variable assignments, so `grep -n patch CLAUDE.md` is a read. A copy or move into a directory (`cp CLAUDE.md sub/`, `cp -t sub CLAUDE.md`) is checked under the name the file gets there. Links are followed. Code run by an interpreter (`python -c "open(...)"`) is not read, and neither are writers zn does not know, such as `sponge` or `awk -i inplace`.

Claude Code saves automatic memory under `~/.claude/projects/*/memory`, so it asks each time it saves there. In `claude -p`, GitHub Copilot autopilot and other modes without a person to answer, a question counts as a refusal. A file directly in an agent's own configuration folder, such as `~/.claude/CLAUDE.md`, was already refused outright and stays refused.

Settings in `~/.zn/config.json`:

| Setting | Effect |
| --- | --- |
| not set | ask (the default) |
| `{"hooks": {"agentInstructionWrites": "deny"}}` or `{"hooks": {"strict": true}}` | refuse the write |
| `{"hooks": {"agentInstructionWrites": "off"}}` (also `false` or `"allow"`) | no check |

`ZN_STRICT=1` in the environment also refuses these writes. The environment can only add protection: turning the check off is only possible from the config file, which the agent's file tools cannot write.

Agents that cannot ask the user show no question, so zn keeps quiet and the agent's own approval rules apply (strict mode still refuses, because a refusal works in every agent):

| Agent | Asks about these writes |
| --- | --- |
| Claude Code, GitHub Copilot CLI, Antigravity | Yes, file tools and shell commands |
| Cursor | Shell commands only; its file tools have no question zn can use |
| Codex CLI, Gemini CLI, OpenCode | No (own approval rules apply) |

A tool that an adapter reports only as a generic file access (some Gemini CLI, Copilot and Antigravity tools) is not asked about: zn cannot tell a read from a write there, and reading these files is never a question.

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

Hermes Agent and the Cursor CLI. GitHub Copilot CLI and Gemini CLI have experimental hooks (see their entries above). A proxy for outgoing
HTTP from `zn run` (for `curl`, `gh` or SDKs) is planned for a later release.
