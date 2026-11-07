# Examples

Worked examples, grouped by what you are trying to do. All values in them are made up.

## Install and upgrade

- [first-project-walkthrough.md](first-project-walkthrough.md): one small example project, from install to removal.
- [init-and-uninstall.md](init-and-uninstall.md): set up zn-gate, preview the steps with a dry run, then remove it.
- [unix-first-run.md](unix-first-run.md): the first ten minutes on macOS or Linux when Node.js came from a version manager.
- [windows-checklist.md](windows-checklist.md): the steps, in order, to install zn-gate on Windows and check that it works.
- [vscode-and-cursor.md](vscode-and-cursor.md): install, verify and uninstall zn-gate for VS Code and Cursor on one page.
- [zed-and-jetbrains.md](zed-and-jetbrains.md): connect, check and remove zn-gate in Zed and in JetBrains editors.
- [uninstall-one-agent.md](uninstall-one-agent.md): turn zn-gate off for one agent and keep it on for the others.
- [upgrade-checklist.md](upgrade-checklist.md): a one-screen checklist for upgrading zn-gate.
- [after-an-upgrade.md](after-an-upgrade.md): five commands to run after an upgrade, and what a good result looks like.

## Everyday use

- [check-output-explained.md](check-output-explained.md): a sample `check` output, read line by line.
- [scan-walkthrough.md](scan-walkthrough.md): run `scan` on a small project and read the result and its exit codes.
- [egress-check.md](egress-check.md): a short walk-through of the egress check with fake hosts.
- [offline-and-local-only.md](offline-and-local-only.md): use zn-gate with no network and with the optional cloud check off.
- [node-api.md](node-api.md): a short tour of the Node.js API, with one small example per call.
- [python-api.md](python-api.md): five short examples of the Python package.

## Cloud check

- [cloud-check-settings.md](cloud-check-settings.md): the settings for the optional cloud check, what each one does and what leaves your machine.
- [connect-and-disconnect.md](connect-and-disconnect.md): connect the optional cloud check, check its status and disconnect.

## Teams

- [evidence-example.md](evidence-example.md): read the local, hash-chained evidence log of what zn-gate decided.
- [stats-and-report.md](stats-and-report.md): worked examples of `stats` and `report` for reviewing results as a team.
- [switching-agents-checklist.md](switching-agents-checklist.md): a checklist for moving from one coding agent to another.

## CI

- [ci-step-example.md](ci-step-example.md): a CI job that runs the check and reads its exit code.
- [scripting.md](scripting.md): using zn-gate from a shell script or a CI job, with exit codes and JSON output.
- [reach-report-file.md](reach-report-file.md): write the reach report to a file in CI and keep it as a build artifact.
