# Examples

Worked examples, grouped by topic. Each group is in alphabetical order. All values in them are made up.

## Setting up, upgrading and removing

- [after-an-upgrade.md](after-an-upgrade.md): five commands to run after you update zn-gate, and what a good result looks like.
- [first-project-walkthrough.md](first-project-walkthrough.md): one small example project, from install to removal.
- [init-and-uninstall.md](init-and-uninstall.md): set up zn-gate, preview the steps with a dry run, then remove it.
- [moving-to-a-new-computer.md](moving-to-a-new-computer.md): set up zn-gate on a new computer, or on a second one, with fictional values.
- [safe-first-day-with-a-new-agent.md](safe-first-day-with-a-new-agent.md): try zn-gate with a new agent in a throwaway folder, then remove it.
- [switching-agents-checklist.md](switching-agents-checklist.md): a checklist for moving zn-gate protection from one coding agent to another.
- [uninstall-one-agent.md](uninstall-one-agent.md): remove zn-gate from one agent and keep it on the others.
- [unix-first-run.md](unix-first-run.md): the first ten minutes on macOS or Linux with a Node.js from a version manager.
- [upgrade-checklist.md](upgrade-checklist.md): a one-screen checklist for upgrading zn-gate.
- [vscode-and-cursor.md](vscode-and-cursor.md): install, verify and remove zn-gate in VS Code and Cursor.
- [windows-checklist.md](windows-checklist.md): install and check zn-gate on Windows, step by step.
- [zed-and-jetbrains.md](zed-and-jetbrains.md): connect, check and remove zn-gate in Zed and JetBrains.

## Checks, scans and reports

- [audit-before-adding-a-repo.md](audit-before-adding-a-repo.md): run `zn-gate audit` on a repository you do not know yet, read the report and decide what to do before you open it with an agent.
- [block-message-anatomy.md](block-message-anatomy.md): one real block message, explained part by part.
- [check-output-explained.md](check-output-explained.md): a sample `zn-gate check` output, explained line by line.
- [egress-check.md](egress-check.md): a short walk-through of the egress check with fake hosts.
- [evidence-example.md](evidence-example.md): the local evidence log, and what `zn-gate evidence` prints.
- [first-block-vs-allow-decision.md](first-block-vs-allow-decision.md): what to do the first time zn-gate blocks a command of your agent, and when to change the settings instead.
- [mcp-server-with-zn-gate.md](mcp-server-with-zn-gate.md): the two MCP servers of zn-gate (`mcp` and `secrets-mcp`): what each does and what the agent sees.
- [offline-and-local-only.md](offline-and-local-only.md): running zn-gate with no network and the cloud check off.
- [package-install-check-walkthrough.md](package-install-check-walkthrough.md): turn on the optional package install check, answer one question about a look-alike name, then allow a name.
- [reading-a-reach-history-report.md](reading-a-reach-history-report.md): how to read the output of zn-gate reach --history.
- [reading-a-scan-finding.md](reading-a-scan-finding.md): what each field of a scan finding means in `--format json` and `--format github`.
- [scan-walkthrough.md](scan-walkthrough.md): scan one small example project and read what each exit code means.
- [stats-and-report.md](stats-and-report.md): worked examples of `zn-gate stats` and `zn-gate report`.
- [which-command-shows-what.md](which-command-shows-what.md): one table with six common questions and the command that answers each.
- [zn-why-allow-command.md](zn-why-allow-command.md): read the output of `zn why`, then run the one command it gives you to allow a blocked action.

## Secrets

- [env-file-round-trip.md](env-file-round-trip.md): move a fake `.env` file into the vault and put the values back.
- [secret-import-and-adopt.md](secret-import-and-adopt.md): import a `.env` file into the vault, then adopt a key the scrubber found.

## Optional cloud check

- [cloud-check-settings.md](cloud-check-settings.md): each setting of the optional cloud check, with its effect and one command.
- [connect-and-disconnect.md](connect-and-disconnect.md): connect, check the status and disconnect the cloud check.
- [first-cloud-check.md](first-cloud-check.md): the shortest path from connect to a first checked prompt, in five steps.
- [long-text-analysis.md](long-text-analysis.md): the two long-input modes of the cloud check, and when the result carries a warning.

## Scripts, CI and APIs

- [ci-step-example.md](ci-step-example.md): a fake CI job that runs the audit and reads its exit code.
- [node-api.md](node-api.md): a short tour of the Node.js API, with one small example per call.
- [python-api.md](python-api.md): five short examples of the Python package.
- [reach-report-file.md](reach-report-file.md): write the reach report to a file in a CI job.
- [scripting.md](scripting.md): use zn-gate from a shell script or a CI job, and read its exit codes.
