# End-to-end runs with real agents

Each run starts a real agent CLI against a **scripted model provider** on
127.0.0.1 (`harness/mock_llm.js`). The provider plays a fixed task and **writes
down every request the agent sends**. "Sent to the provider" below means
exactly those requests: what a real model and its provider would have
received. No real model, account or API key is used, and every value is fake
(the leak bench generator).

## The task

Each agent runs the same steps, using its own tools:

1. Read the project's `.env` (shadowed: markers only).
2. Read `config/settings.yml`, which holds plain-text fake AWS keys.
3. Write `src/client.js` with a marker in it. The file is tracked by git, so the marker stays.
4. Run an allowed command that gets the secret as an environment variable (`zn run --secrets DB_PASSWORD -- node -e "console.log(process.env.DB_PASSWORD)"`). It prints the value, and zn masks it. A marker in a command's arguments is refused, never filled in, so the task does not use one (Codex also tries the refused form once).
5. Run a command the user does not approve (`python3 …` with the same `zn run --secrets` form).
6. Read `~/.aws/credentials`.
7. Claude Code only: restore a detected token into a local command (`printf %s __ZN_AWS_KEY_1__ | wc -c`).
8. In a second session, send a prompt with a fake secret pasted in it.

`harness/vault_daemon.js` plays the user on the vault's confirmation channel:
it approves first use by `node` and declines everything else.
`harness/approver_mcp.js` plays the user answering Claude Code's permission
dialogs (`--permission-prompt-tool`): it approves, and logs what the dialog
showed.

## Results (2026-10-31, Ubuntu 26.04, Node 24.22)

| Agent | Version | Values sent to the provider | Notes |
|---|---|---|---|
| Claude Code | 2.1.316 | **0** | Outputs scrubbed before the model. The allowed command ran through `zn run` (output masked). The declined command exited 77. The credential read was denied. The pasted prompt was stopped before any request. |
| Codex CLI | 0.166.0 | **0** | The command with a marker in its arguments was denied with the guidance to use `zn run --secrets NAME`, and the agent's `zn run --secrets` call then worked. Output was replaced through "block". The pasted prompt was blocked. |
| OpenCode | 1.19.5 | **0** | The agent's `zn run --secrets` command ran, outputs and TUI previews scrubbed, the credential read blocked, the pasted prompt stopped (OpenCode reports it as a server error). |
| Cursor | — | not run | No Cursor CLI with hooks can be driven from a script. The adapter is covered by unit tests on the documented event shapes. |

**Does Claude Code forward a rewritten command to the model?** No. When zn
restores `__ZN_AWS_KEY_1__` for a local command (step 7):

- The dialog shows the real value (`claude-code/permission-prompts.redacted.jsonl`).
- The conversation sent to the model keeps the token, in that turn, in every
  later turn, and after `claude --resume`.
- Claude Code does record the rewritten command in its local transcript, as
  hook output.

**Local copies** (not sent; see `docs/threat-model.md`):

| Agent | Values in its local files |
|---|---|
| Claude Code | The blocked prompt and the restored command (step 7), in the session transcripts |
| Codex | The original command output, in its session log and `--json` events, because Codex cannot rewrite output |
| OpenCode | The live output of a running command, in its database |

The Codex sandbox (`-s workspace-write`) could not start on the test host
(bubblewrap: `Failed RTM_NEWADDR`), so `zn run` inside the Codex sandbox is not
verified. The runs above use `--dangerously-bypass-approvals-and-sandbox`.

## Codex hook scenarios

`harness/run_codex_scenarios.sh` adds one case per hook event to the Codex run
(same scripted provider, same fake values). Evidence is in `codex/scenarios/<case>/`
(`summary.txt`, `leak-check.txt`, `hooks.txt`, `checks.txt`, `exit-codes.txt`).
Every case checks the exit code and that no fake value was sent to the provider.

| Case | What it runs | Result (Codex CLI 0.163.0) |
|---|---|---|
| `permission` | `PermissionRequest` with approvals on, in the terminal UI through a pseudo-terminal (`codex exec` never asks for approval, so the event does not run there). A command with a placeholder, then an ordinary one that needs approval; the driver never approves. | zn denies the first with its reason; for the second it gives no answer and the approval prompt stays (declined). |
| `mcp` | Three calls to a small MCP server through `PreToolUse`: a placeholder, a secret value, plain text. | The first two are denied with zn's reason and never reach the server; the third goes through. |
| `session-context` | `SessionStart` and `SubagentStart` (the model starts a subagent with `spawn_agent`, which reads a credential file). | The reminder reaches the model and the subagent's model; the subagent's tool call goes through `PreToolUse` and is denied (observation for the subagent). |
| `stop-warn` | `Stop` with a secret value in the final answer. | zn warns with `systemMessage`; nothing is blocked. `codex exec` does not show the warning. |
| `stop-block` | The same with `"stopReview": "block"`. | Codex continues once with zn's reason; the second answer is not blocked again. |
| `stop-placeholder` | `Stop` with a placeholder no tool produced (observation). | Not flagged: Codex writes the answer to its session log three times. |
| `replace` | `PostToolUse` with `replaceToolOutputOnSecret`. | zn returns `continue: false` and a stop reason; the model gets the tokenized copy and the turn goes on. |
| `thirdparty` | Another tool's `PreToolUse` hook answers `allow` with `updatedInput` (observation). | zn's `PreToolUse` sees the original command and the rewritten one runs. zn's `PostToolUse` sees the command that ran, answers `block`, and the model gets zn's "output was withheld" message instead of a scrubbed copy. Nothing reaches the provider. |

The `mcp` and `stop-block` cases use a fake key that the scripted model writes
itself, so it comes back in the next request; it is checked against what the MCP
server received instead of against what was sent. Run them with
`bash bench/e2e/harness/run_codex_scenarios.sh <work dir> <codex binary> [case ...]`.
These cases pair with the weekly compatibility check, which compares fresh runs
with the committed evidence.

## Files

- `<agent>/summary.txt`: every tool call and the result the model got, as the provider received them (fake values would show as `<<LEAK:NAME>>`).
- `<agent>/leak-check.txt`: every fake value and its base64, base64url, hex and URL-encoded forms, searched in what was sent (`sent`) and in the agent's local files (`local`).
- `<agent>/confirmations.jsonl`: what the vault asked out of band, and the answer.

## Reproduce

```bash
npm install -g --prefix /tmp/agents @anthropic-ai/claude-code @openai/codex opencode-ai
bash bench/e2e/harness/run_all.sh /tmp/zn-e2e /tmp/agents/bin
```

OpenCode downloads its `@ai-sdk/openai-compatible` provider package on first
use.
