# Agent exposure matrix

This page shows, for each agent zn-gate supports, what zn did in each of seven cases: a read of a `.env` file with plain-text secrets, a shell command's output, an MCP tool's output, a prompt with a pasted secret, a check that runs past its time limit, a check that crashes, and a machine where Node.js is missing.

Every cell comes from a recorded run or from an automated test in this repository. A cell that no run or test covers says **Not tested**. That does not mean the agent is unprotected: it means we have no evidence for that case yet. For the protection each agent gets in general, see [Agent compatibility](compat.md) and [Editors and coding agents](editors/README.md).

Results come from release 1.15.0 (published 2026-11-06) and from the runs and tests listed below. Each cell shows the zn-gate version and the date of its newest source.

## How to read a cell

- **Blocked**: zn stopped the action, or stopped the output or the prompt before the model saw it.
- **Reaches with warning**: the action ran, and zn replaced the secret value with a marker or added a notice for the agent. No secret value reached the model.
- **Reaches**: the action ran and zn did not change it.
- **Not tested**: no recorded run or repository test covers this case for this agent.

For the timeout and crash cases, the test checks zn's own hook, which answers before the agent's limit. The agent's own timeout behaviour is not covered by these tests unless the notes say so.

## Matrix

| Agent | `.env` read | Shell output | MCP output | Pasted prompt | Timeout | Crash | Node.js missing |
| - | - | - | - | - | - | - | - |
| Claude Code | Blocked, 1.15.0, 2026-11-06 [R1] | Reaches with warning, version not recorded, 2026-10-31 [R6] | Reaches with warning, 1.15.0 source, 2026-11-09 [T8] | Blocked, version not recorded, 2026-10-31 [R6] | Blocked, 1.15.0 source, 2026-11-09 [T1] | Blocked, 1.15.0 source, 2026-11-09 [T2] | Blocked, 1.15.0 source, 2026-11-09 [T5] |
| Codex CLI | Blocked, 1.15.0, 2026-11-06 [R1][R2] | Reaches with warning, version not recorded, 2026-10-31 [R6][R7] | Reaches with warning, 1.15.0 source, 2026-11-09 [T9] | Blocked, version not recorded, 2026-10-31 [R2][R6] | Blocked, 1.15.0 source, 2026-11-09 [T1][T2] | Blocked, 1.15.0 source, 2026-11-09 [T2] | Blocked, 1.15.0 source, 2026-11-09 [R2][T6] |
| Cursor | Blocked, 1.15.0, 2026-11-06 [R1] | Reaches, 1.15.0 source, 2026-11-09 [T7] | Reaches with warning, 1.15.0 source, 2026-11-09 [T7] | Blocked, 1.15.0 source, 2026-11-09 [T7] | Blocked, 1.15.0 source, 2026-11-09 [T1] | Not tested | Not tested |
| OpenCode | Not tested | Reaches with warning, version not recorded, 2026-10-31 [R6][R7] | Not tested | Blocked, version not recorded, 2026-10-31 [R6][R7] | Blocked, 1.15.0 source, 2026-11-09 [T1] | Not tested | Not tested |
| Google Antigravity | Blocked, 1.14.0, 2026-10-25 [R3] | Not tested | Not tested | Not tested | Blocked, 1.15.0 source, 2026-11-09 [T1] | Blocked, 1.15.0 source, 2026-11-09 [T4] | Blocked, 1.15.0 source, 2026-11-09 [T4] |
| ZCode desktop app | Blocked, development build, 2026-11-04 [R4][R5] | Not tested | Not tested | Blocked, 1.14.0, 2026-10-24 [R4] | Blocked, development build, 2026-11-04 [R5][T1] | Blocked, 1.15.0 source, 2026-11-09 [T3] | Blocked, 1.15.0 source, 2026-11-09 [R4][T3] |
| GitHub Copilot CLI | Not tested | Reaches with warning, 1.15.0 source, 2026-11-09 [R8][T10] | Not tested | Not tested | Blocked, 1.15.0 source, 2026-11-09 [T1] | Not tested | Not tested |
| Gemini CLI (experimental) | Not tested | Not tested | Not tested | Not tested | Blocked, 1.15.0 source, 2026-11-09 [T1] | Not tested | Blocked, 1.15.0 source, 2026-11-09 [T4] |

Counts: 35 cells are tested and 21 are not tested.

## Sources

Runs (end-to-end, with the real agent unless the table says otherwise):

| ID | What was run | zn-gate version | Date |
| - | - | - | - |
| R1 | Release check of 1.15.0: clean install on Linux. The installed hook commands were given the same payloads the agents send. No agent was started (hook replay). | 1.15.0 | 2026-11-06 |
| R2 | Codex CLI 0.164.0 with the zn-gate plugin, including a run with no Node.js on the hook's path. | 1.13.1 and 1.14.0 builds | 2026-10-25 |
| R3 | Antigravity CLI 1.4.7 with the zn-gate plugin, on Ubuntu 24.04. | 1.14.0 build | 2026-10-25 |
| R4 | ZCode desktop app 3.16.3 on Linux, with the zn-gate plugin. | 1.14.0 | 2026-10-24 |
| R5 | ZCode desktop app 3.16.3 on Windows Server 2022: busy-machine and stuck-hook runs. | development build of the 1.15.0 Windows fixes | 2026-11-04 |
| R6 | Claude Code 2.1.316, Codex CLI 0.166.0 and OpenCode 1.19.5 against a scripted model provider (the scenario in `bench/e2e/README.md`). | not recorded in the run files | 2026-10-31 |
| R7 | Codex CLI 0.163.0 and OpenCode 1.19.3 on Windows Server 2022 (`bench/e2e/windows`). | not recorded in the run files | 2026-10-19 |
| R8 | GitHub Copilot CLI 1.0.98 against a scripted model provider (`bench/e2e/copilot`). The scenario has no pasted-prompt step. | not recorded in the run files | 2026-10-19 |

Repository tests, at commit 60f3385 (package version 1.15.0), run by the test suite of `packages/zn-gate/test`:

| ID | File | What it checks |
| - | - | - |
| T1 | `hooks_supervisor.test.js` (lines 66, 74, 102) | A hook whose input never ends, and a check that hangs, are blocked at zn's deadline. The input and hang tests run for all eight hook agents; the 20-second hang test runs for Gemini and Copilot. |
| T2 | `hooks_codex_fail_closed.test.js` (lines 59, 66-74, 107) | A hung check, an error, an uncaught exception and an unhandled rejection are denied with exit code 2 (Codex). Claude Code keeps a deny answer on a forced error. |
| T3 | `hooks_zcode.test.js` (lines 304, 474) | A hung or crashing check is denied with exit code 2 (ZCode). With no Node.js, the blocking events exit 2. |
| T4 | `hooks_more_launcher.test.js` (lines 125, 159, 182; 277 is Windows only) | Gemini with no Node.js blocks with exit 2. Antigravity with no Node.js answers a deny. An Antigravity hook that fails is answered with a deny. |
| T5 | `hooks_claude_launcher.test.js` (line 77) | With no Node.js, Claude Code's PreToolUse and prompt events block with exit 2. |
| T6 | `hooks_codex_launcher.test.js` (line 82) | With no Node.js, Codex still blocks, with the exit codes Codex documents. |
| T7 | `hooks_agents.test.js` (line 138) | Cursor: MCP output is tokenized, shell output is not rewritten (a documented limit), and a prompt with a secret is blocked. |
| T8 | `hooks_output_instructions.test.js` (line 30) and `hooks_claude_code.test.js` (line 219) | Claude Code: flagged MCP output keeps its content and tells the agent; PostToolUse covers MCP. |
| T9 | `hooks_paths_agents.test.js` (line 428) | Codex tokenizes the output of tools it does not know, such as MCP tools. |
| T10 | `hooks_copilot.test.js` (line 199) | Copilot: a secret in a shell result is replaced; clean and failed results are left alone. |

The release soak of 1.15.0 replayed benign and risky action sets through all six hook agents. It is not listed in the cells because it does not split results by these seven cases.

## Notes

- **Cursor** has no CLI that can be driven from a script. Its `.env` result is a hook replay (R1), not a run of the Cursor app.
- **OpenCode** and **Copilot CLI**: the `.env` file used in their runs (R6, R8) held markers only, so those runs do not show what happens with plain-text values. The `.env` cell for both stays Not tested.
- **Antigravity** runs (R3) were inconclusive twice because the model refused the call before any hook ran; the third run made the call and the plugin's hook denied it.
- **Antigravity**'s documentation says its hooks cannot rewrite tool output, so its shell and MCP output cells stay Not tested. Copilot's install report says its timeout fails open. Our timeout tests cover zn's own deadline, not the agent's timeout, so the timeout cells mean "zn blocks at its deadline".
- **Gemini CLI** is experimental. Its install warning says it fails open on a crash; no test or run confirms the crash behaviour, so the crash cell is Not tested.
- **ZCode** on Windows: the earlier run with a 30-second hook timeout let a stuck check's call through. The current results are from runs after that fix.
- **Windows and Node.js missing**: the Cursor and Gemini deny test (T4, line 277) runs on Windows only. It does not count for Linux.

To add a result, add a row to the matrix and a source line above; keep the version and date with it.
