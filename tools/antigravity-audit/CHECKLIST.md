# Antigravity hooks: checklist for a human run

Purpose: close the seven open points of the experimental Antigravity hooks adapter in zn-gate (`packages/zn-gate/lib/agents/antigravity.js`). Run it on your own machine, in Antigravity App, CLI or IDE, with a test workspace that holds no real secrets.

Before you start:

- Install the kit as described in `README.md`. Use `hooks-example.json` as the starting point.
- Create a test workspace, for example `C:\zn-test-ws\`. Put in it a file `notes.txt` with one line of text, and a file `.env` with the fake line `FAKE_TOKEN=not-a-real-token`.
- Run the `zn-audit-shape` entry first. It records every call and always allows, so it does not change the session.
- Keep the output file open after each step. Each step should add lines to it.

## The seven open points

1. Argument names of the file tools (view_file, write_to_file, replace_file_content, multi_replace_file_content, grep_search).
2. Name that the hook sees for MCP tools.
3. Behavior on hook failure, timeout, exit code 2, non-JSON output or empty output (block or pass).
4. Whether deny and force_ask reasons are shown to the user or the agent, and whether allow skips the user's own rules.
5. Precedence between user, project and plugin hooks.
6. Whether grep_search respects .gitignore.
7. Windows (shell used by run_command, and the hook loading in App, CLI and IDE).

## Steps and the open point each one answers

| Step | Action in Antigravity | Hook entry | Answers point |
|---|---|---|---|
| A1 | Ask: "View the file notes.txt." (view_file) | zn-audit-shape | 1 (argument names), 7 (matcher and tool names) |
| A2 | Ask: "Create a file named made.txt with the text hello." (write_to_file) | zn-audit-shape | 1 |
| A3 | Ask: "In made.txt, replace hello with bye." (replace_file_content) | zn-audit-shape | 1 |
| A4 | Ask: "In made.txt, change hello to hi and bye to ciao, in two separate edits." (multi_replace_file_content) | zn-audit-shape | 1 |
| A5 | Ask: "Search the folder for the word line." (grep_search) and "List the folder." (list_dir) | zn-audit-shape | 1, 6 |
| A6 | Ask: "Run the command echo audit-test." (run_command) | zn-audit-shape | 7 (shell used) |
| B1 | Ask for any call to an MCP tool from a server you already have configured, for example a harmless "echo" or "list" tool. | zn-audit-shape | 2 (MCP tool names) |
| C1 | Add a `.gitignore` in the test workspace that lists `ignored.txt`. Create `ignored.txt` with the text `zzz-marker`. Ask: "Search the folder for zzz-marker." | zn-audit-shape | 6 (grep_search respects .gitignore) |
| D1 | Replace the entry in hooks.json with `zn-audit-probe` using `--probe deny`, matcher `write_to_file`. Ask to create a file. | zn-audit-probe | 4 (deny reason shown) |
| D2 | Same, with `--probe force-ask`. Ask to create a file. | zn-audit-probe | 4 (force_ask shown, reason shown) |
| D3 | Same, with `--probe ask`. | zn-audit-probe | 4 |
| E1 | Same, with `--probe exit2`, matcher `write_to_file`. Ask to create a file. Note whether the file appears. | zn-audit-probe | 3 (exit 2 counts as block?) |
| E2 | `--probe garbage`, same matcher. Ask to create a file. Note whether the file appears. | zn-audit-probe | 3 (non-JSON output) |
| E3 | `--probe empty`, same matcher. Ask to create a file. Note whether the file appears. | zn-audit-probe | 3 (empty output) |
| E4 | `--probe hang`, timeout 5 in the entry, same matcher. Ask to create a file. Note how long the call takes and whether it goes through. | zn-audit-probe | 3 (timeout) |
| F1 | Put the probe `deny` entry in `<test-ws>\.agents\hooks.json` (project level) while the global entry stays `allow`. Ask to create a file. | zn-audit-probe + global | 5 (precedence, project versus global) |
| F2 | Add a user-level `ask` rule for `run_command` in Antigravity permissions, then a probe `allow` hook for run_command. Ask to run the echo command. Note whether the prompt still appears. | zn-audit-probe | 5 (allow does not skip user rules) |
| G1 | Repeat A1 to A6 in each surface: App, CLI, IDE. In the CLI also type `/hooks` and copy what it lists. | zn-audit-shape | 7 (loading in App, CLI and IDE) |
| H1 | Windows only: ask the agent to run `echo $PSVersionTable.PSVersion` and to run `dir`. Read the answer to see which shell ran the command. | zn-audit-shape | 7 (shell on Windows) |

After every step, remove the probe entry before the next group, unless the step says otherwise. Keep the test workspace separate from any real project.

## What to write down for each point

For each step, record:

1. The Antigravity surface (App, CLI or IDE) and its version.
2. What you asked and what the agent did.
3. What appeared in the output file (the new lines, not the whole file).
4. What the UI or the agent showed, copied as text. For point 4, copy the exact reason text shown.

## Answers already in the public docs (check against your run)

The hooks page (`antigravity.google/docs/hooks`, read 2026-10-18) documents:

- Argument names: `view_file` (AbsolutePath), `write_to_file` (TargetFile), `replace_file_content` and `multi_replace_file_content` (TargetFile), `grep_search` (SearchPath), `list_dir` (DirectoryPath), `run_command` (CommandLine, Cwd). These match what the adapter expects, except `grep_search` uses `SearchPath`, which the adapter already matches by key name.
- Matcher `*` or an empty matcher matches all tools.
- Each hook handler has an optional `timeout` in seconds, default 30.
- PreToolUse decisions: allow, auto_approve, deny, ask, force_ask, deny_unless_prior_grant. `reason` is documented as shown "to the agent or to you".
- Hook files: `.agents/hooks.json` (workspace) and `~/.gemini/config/hooks.json` (global) in App, CLI and IDE.

Not documented: how a crash, timeout, exit code 2 or empty output is treated; MCP tool naming; `.gitignore` handling in `grep_search`; Windows shell for `run_command`; precedence against plugin hooks. Steps E1 to E4, B1, C1, F1 to F2 and H1 are there to answer these.

## Send back

Send the `.jsonl` file and your notes for each step (one line per step is enough). Do not send the test workspace.
