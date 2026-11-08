# Examples

Worked examples, grouped by what you want to do. All values in them are made up. Within each group the pages are in alphabetical order.

## First steps

| Page | What it shows |
|---|---|
| [first-project-walkthrough.md](first-project-walkthrough.md) | One small example project, from install to removal. |
| [init-and-uninstall.md](init-and-uninstall.md) | Set up zn-gate, preview the steps with a dry run, then remove it. |
| [moving-to-a-new-computer.md](moving-to-a-new-computer.md) | Set up zn-gate on a new computer, or on a second one, with fictional values. |
| [safe-first-day-with-a-new-agent.md](safe-first-day-with-a-new-agent.md) | Try zn-gate with a new agent in a throwaway folder, then remove it. |
| [unix-first-run.md](unix-first-run.md) | The first ten minutes on macOS or Linux when Node.js comes from a version manager. |
| [windows-checklist.md](windows-checklist.md) | The steps, in order, to install and check zn-gate on Windows. |

## Reading the output

| Page | What it shows |
|---|---|
| [audit-before-adding-a-repo.md](audit-before-adding-a-repo.md) | Run `zn-gate audit` on a repository you do not know yet, read the report and decide what to do before you open it with an agent. |
| [block-message-anatomy.md](block-message-anatomy.md) | One real block message, explained part by part. |
| [check-output-explained.md](check-output-explained.md) | A sample `check` output explained line by line. |
| [evidence-example.md](evidence-example.md) | `zn-gate evidence`: the counts, the latest records and how to verify the log. |
| [first-block-vs-allow-decision.md](first-block-vs-allow-decision.md) | What to do the first time zn-gate blocks a command of your agent, and when to change the settings instead. |
| [reading-a-reach-history-report.md](reading-a-reach-history-report.md) | How to read the output of `zn-gate reach --history`. |
| [reading-a-scan-finding.md](reading-a-scan-finding.md) | What each field of a scan finding means in `--format json` and `--format github`. |
| [scan-walkthrough.md](scan-walkthrough.md) | Scan one small example project, from the run to what each exit code means. |
| [stats-and-report.md](stats-and-report.md) | Worked examples of `zn-gate stats` and `zn-gate report`. |
| [which-command-shows-what.md](which-command-shows-what.md) | Six common questions and the command that answers each. |
| [zn-why-allow-command.md](zn-why-allow-command.md) | Read the output of `zn why`, then run the one command it gives you to allow a blocked action. |

## Cloud check

| Page | What it shows |
|---|---|
| [cloud-check-settings.md](cloud-check-settings.md) | Each cloud check setting with its effect, one command and what leaves your machine. |
| [connect-and-disconnect.md](connect-and-disconnect.md) | Connect, check the status and disconnect. |
| [first-cloud-check.md](first-cloud-check.md) | The shortest path from connect to a first checked prompt, in five steps. |
| [long-text-analysis.md](long-text-analysis.md) | The two long-input modes of the cloud check (`windows` or `off`), and when the result carries a warning. |
| [offline-and-local-only.md](offline-and-local-only.md) | Use zn-gate with no network and with the cloud check off. |

## Personal data in requests

| Page | What it shows |
|---|---|
| [egress-check.md](egress-check.md) | A short walk-through of the egress check with fake hosts. |

## Secrets and the vault

| Page | What it shows |
|---|---|
| [env-file-round-trip.md](env-file-round-trip.md) | Move a fake `.env` file into the vault and put the values back. |

## Editors and agents

| Page | What it shows |
|---|---|
| [mcp-server-with-zn-gate.md](mcp-server-with-zn-gate.md) | The two MCP servers of zn-gate (`mcp` and `secrets-mcp`): what each does and what the agent sees. |
| [package-install-check-walkthrough.md](package-install-check-walkthrough.md) | Turn on the optional package install check, answer one question about a look-alike name, then allow a name. |
| [switching-agents-checklist.md](switching-agents-checklist.md) | Move zn-gate protection from one agent to another. |
| [vscode-and-cursor.md](vscode-and-cursor.md) | Install, verify and uninstall zn-gate for VS Code and Cursor on one page. |
| [zed-and-jetbrains.md](zed-and-jetbrains.md) | Connect, check and remove zn-gate in Zed and JetBrains editors. |

## Upgrade and remove

| Page | What it shows |
|---|---|
| [after-an-upgrade.md](after-an-upgrade.md) | Five commands to run after an upgrade, and what a good result looks like. |
| [uninstall-one-agent.md](uninstall-one-agent.md) | Remove zn-gate from one agent and keep the others. |
| [upgrade-checklist.md](upgrade-checklist.md) | A one-screen checklist for upgrading zn-gate. |

## Scripts and CI

| Page | What it shows |
|---|---|
| [ci-step-example.md](ci-step-example.md) | A CI job that runs the audit and reads its exit code. |
| [reach-report-file.md](reach-report-file.md) | Write the reach report to a file in CI and keep it as a build artifact. |
| [scripting.md](scripting.md) | zn-gate in a shell script and in a CI job: exit codes and JSON output. |

## Node.js and Python

| Page | What it shows |
|---|---|
| [node-api.md](node-api.md) | A short tour of the Node.js API, with one example per call. |
| [python-api.md](python-api.md) | Five short examples of the Python package. |

<!-- Contributors: add one row to the table of the matching group for every new page in this folder, in alphabetical order within the group. Add a new group only if no existing one fits. -->
