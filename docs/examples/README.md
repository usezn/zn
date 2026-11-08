# Examples

Worked examples, in alphabetical order. All values in them are made up.

- [after-an-upgrade.md](after-an-upgrade.md): five commands to run after you update zn-gate, and what a good result looks like.
- [block-message-anatomy.md](block-message-anatomy.md): one real block message, explained part by part.
- [check-output-explained.md](check-output-explained.md): a sample `check` output, read line by line.
- [ci-step-example.md](ci-step-example.md): one fake CI job that runs the audit and reads its exit code.
- [cloud-check-settings.md](cloud-check-settings.md): each cloud check setting with its effect, one fake command and what leaves the machine.
- [connect-and-disconnect.md](connect-and-disconnect.md): turn the optional cloud check on, check its status and turn it off.
- [egress-check.md](egress-check.md): a short walk-through of the egress check with fake hosts.
- [env-file-round-trip.md](env-file-round-trip.md): move a fake `.env` file into the vault and put the values back.
- [evidence-example.md](evidence-example.md): the local evidence log that `zn-gate evidence` shows.
- [first-cloud-check.md](first-cloud-check.md): the shortest path from connect to a first checked prompt, in five steps.
- [first-project-walkthrough.md](first-project-walkthrough.md): one small example project, from install to removal.
- [init-and-uninstall.md](init-and-uninstall.md): set up zn-gate, preview the steps with a dry run, then remove it.
- [long-text-analysis.md](long-text-analysis.md): the two long-input modes of the cloud check (`windows` or `off`), and when the result carries a warning.
- [moving-to-a-new-computer.md](moving-to-a-new-computer.md): what moves and what does not when you set up zn-gate on a new computer, with fictional values.
- [node-api.md](node-api.md): install and one short example per call of the Node.js API.
- [offline-and-local-only.md](offline-and-local-only.md): use zn-gate with no network and with the optional cloud check off.
- [package-install-check-walkthrough.md](package-install-check-walkthrough.md): turn on the optional package install check, answer one question about a look-alike name, then allow a name.
- [python-api.md](python-api.md): five short examples of the Python package.
- [reach-report-file.md](reach-report-file.md): write the `reach` report to a file in CI and keep it as a build artifact.
- [reading-a-reach-history-report.md](reading-a-reach-history-report.md): how to read the output of zn-gate reach --history.
- [scan-walkthrough.md](scan-walkthrough.md): scan one small example project, from the run to what each exit code means.
- [scripting.md](scripting.md): use `zn-gate` from a shell script or a CI job: exit codes and JSON output.
- [stats-and-report.md](stats-and-report.md): worked examples of `zn-gate stats` and `zn-gate report`.
- [switching-agents-checklist.md](switching-agents-checklist.md): a checklist for moving zn-gate protection from one coding agent to another.
- [uninstall-one-agent.md](uninstall-one-agent.md): remove zn-gate from one agent and keep the others.
- [unix-first-run.md](unix-first-run.md): the first ten minutes on macOS or Linux with a Node.js from a version manager.
- [upgrade-checklist.md](upgrade-checklist.md): a one-screen version of the upgrade page.
- [vscode-and-cursor.md](vscode-and-cursor.md): install, verify and uninstall for VS Code and Cursor on one page.
- [which-command-shows-what.md](which-command-shows-what.md): one table with six common questions and the command that answers each.
- [windows-checklist.md](windows-checklist.md): the steps, in order, to install zn-gate on Windows and check that it works.
- [zed-and-jetbrains.md](zed-and-jetbrains.md): connect, check and remove zn-gate in Zed and JetBrains editors.
- [zn-why-allow-command.md](zn-why-allow-command.md): read the output of `zn why`, then run the one command it gives you to allow a blocked action.
