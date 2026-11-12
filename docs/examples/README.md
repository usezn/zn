# Examples

Worked examples, grouped by topic. Each group is in alphabetical order. All values in them are made up.

The code examples that run with zn-gate, with the command to run each one, are indexed in [examples/README.md](../../examples/README.md).

## Setting up, upgrading and removing

- [after-an-upgrade.md](after-an-upgrade.md): five commands to run after you update zn-gate, and what a good result looks like.
- [agents-on-a-shared-machine.md](agents-on-a-shared-machine.md): several people on one computer: what is kept for each user, what is global, and what one user cannot see of another.
- [claude-code-plugin-or-cli.md](claude-code-plugin-or-cli.md): the two ways to cover Claude Code (the plugin, or the hooks of `zn hooks install claude-code`), what each needs, and how to verify and remove them.
- [continue-hook-setup.md](continue-hook-setup.md): set up zn-gate as an MCP server in Continue, with made-up values, and check it.
- [first-project-walkthrough.md](first-project-walkthrough.md): one small example project, from install to removal.
- [hook-subcommand-explained.md](hook-subcommand-explained.md): what `zn-gate hook` is, who calls it, and why you rarely run it by hand.
- [hooks-install-and-uninstall.md](hooks-install-and-uninstall.md): install and remove the hooks of one agent, for your user or one project, and check the result.
- [hooks-status-after-agent-update.md](hooks-status-after-agent-update.md): re-check the hooks with `zn-gate check` and `zn-gate check --hooks` after your coding agent updated itself.
- [hooks-uninstall-then-verify.md](hooks-uninstall-then-verify.md): remove zn's hooks and confirm with `zn-gate check --hooks` that none is left.
- [init-and-uninstall.md](init-and-uninstall.md): set up zn-gate, preview the steps with a dry run, then remove it.
- [moving-to-a-new-computer.md](moving-to-a-new-computer.md): set up zn-gate on a new computer, or on a second one, with fictional values.
- [python-only-first-run.md](python-only-first-run.md): from `pip install zn-gate` to a fake secret being blocked, with the Python package and no Node.js.
- [safe-first-day-with-a-new-agent.md](safe-first-day-with-a-new-agent.md): try zn-gate with a new agent in a throwaway folder, then remove it.
- [switching-agents-checklist.md](switching-agents-checklist.md): a checklist for moving zn-gate protection from one coding agent to another.
- [uninstall-one-agent.md](uninstall-one-agent.md): remove zn-gate from one agent and keep it on the others.
- [unix-first-run.md](unix-first-run.md): the first ten minutes on macOS or Linux with a Node.js from a version manager.
- [upgrade-checklist.md](upgrade-checklist.md): a one-screen checklist for upgrading zn-gate.
- [vscode-and-cursor.md](vscode-and-cursor.md): install, verify and remove zn-gate in VS Code and Cursor.
- [windows-checklist.md](windows-checklist.md): install and check zn-gate on Windows, step by step.
- [zed-and-jetbrains.md](zed-and-jetbrains.md): connect, check and remove zn-gate in Zed and JetBrains.
- [zn-hooks-install-for-one-agent.md](zn-hooks-install-for-one-agent.md): install the hooks for one coding agent only, then verify them with `check --hooks` and `check`.
- [zn-hooks-install-with-a-custom-home.md](zn-hooks-install-with-a-custom-home.md): install hooks with a custom `ZN_HOME`: where the files go, what the hooks refer to, and how to clean up.
- [zn-hooks-status-for-a-teammate-handoff.md](zn-hooks-status-for-a-teammate-handoff.md): a checklist before a computer with zn-gate goes to a teammate: what to check, what not to hand over, what to remove.

## Checks, scans and reports

- [audit-before-adding-a-repo.md](audit-before-adding-a-repo.md): run `zn-gate audit` on a repository you do not know yet, read the report and decide what to do before you open it with an agent.
- [audit-before-opening.md](audit-before-opening.md): run `zn audit` on a repository you just cloned, before an agent opens it, and read what the report says.
- [audit-report-to-file.md](audit-report-to-file.md): save the audit report to a file in text, JSON or SARIF, and compare two runs.
- [block-message-anatomy.md](block-message-anatomy.md): one real block message, explained part by part.
- [check-output-explained.md](check-output-explained.md): a sample `zn-gate check` output, explained line by line.
- [doctor-before-asking-for-help.md](doctor-before-asking-for-help.md): the commands to run in your own terminal, and paste, before you ask for help.
- [egress-check.md](egress-check.md): a short walk-through of the egress check with fake hosts.
- [evidence-example.md](evidence-example.md): the local evidence log, and what `zn-gate evidence` prints.
- [evidence-verify-after-restore.md](evidence-verify-after-restore.md): check that a decision log you brought to a new computer arrived whole and unchanged.
- [first-block-vs-allow-decision.md](first-block-vs-allow-decision.md): what to do the first time zn-gate blocks a command of your agent, and when to change the settings instead.
- [mcp-pin-review-checklist.md](mcp-pin-review-checklist.md): what to compare in a changed MCP tool before you approve it with `pins approve`.
- [mcp-server-with-zn-gate.md](mcp-server-with-zn-gate.md): the two MCP servers of zn-gate (`mcp` and `secrets-mcp`): what each does and what the agent sees.
- [offline-and-local-only.md](offline-and-local-only.md): running zn-gate with no network and the cloud check off.
- [package-install-check-walkthrough.md](package-install-check-walkthrough.md): turn on the optional package install check, answer one question about a look-alike name, then allow a name.
- [reading-a-reach-history-report.md](reading-a-reach-history-report.md): how to read the output of zn-gate reach --history.
- [reading-a-scan-finding.md](reading-a-scan-finding.md): what each field of a scan finding means in `--format json` and `--format github`.
- [scan-a-single-file.md](scan-a-single-file.md): scan one file instead of a folder, and read the report.
- [scan-walkthrough.md](scan-walkthrough.md): scan one small example project and read what each exit code means.
- [sharing-findings-with-a-teammate.md](sharing-findings-with-a-teammate.md): save scan and audit output to a file and check it holds no real secret before you send it.
- [shield-first-run.md](shield-first-run.md): wrap one MCP server with the shield in shadow mode, see what it prints, then enforce or undo it.
- [shield-walkthrough.md](shield-walkthrough.md): wrap a fake MCP server with the shield, from shadow mode to enforce and back.
- [stats-and-report.md](stats-and-report.md): worked examples of `zn-gate stats` and `zn-gate report`.
- [stats-share-controls.md](stats-share-controls.md): check, turn on and turn off the optional sharing of daily counts.
- [which-command-shows-what.md](which-command-shows-what.md): one table with six common questions and the command that answers each.
- [why-blocked-walkthrough.md](why-blocked-walkthrough.md): one blocked command, from what the agent sees to the `zn why` output and the allow step.
- [zn-hooks-status-before-opening-a-pr.md](zn-hooks-status-before-opening-a-pr.md): a short checklist to run before you open a pull request: check, check --hooks and check --json, and what each result means.
- [zn-pins-in-a-shared-repo.md](zn-pins-in-a-shared-repo.md): where MCP tool pins are kept, and why there is nothing to commit or ignore in a shared repository.
- [zn-reach-with-remember-twice.md](zn-reach-with-remember-twice.md): run `reach --remember` several times on a fake project and read what changes in the output between runs.
- [zn-why-allow-command.md](zn-why-allow-command.md): read the output of `zn why`, then run the one command it gives you to allow a blocked action.

## Secrets

- [env-file-round-trip.md](env-file-round-trip.md): move a fake `.env` file into the vault and put the values back.
- [keep-a-secret-out-of-the-agent.md](keep-a-secret-out-of-the-agent.md): store one fake secret, let one command use it, then remove it.
- [secret-adopt-existing-file.md](secret-adopt-existing-file.md): adopt a secret that zn-gate found in a project file, from the token it was replaced with to a named vault secret, and the check afterwards.
- [secret-import-and-adopt.md](secret-import-and-adopt.md): import a `.env` file into the vault, then adopt a key the scrubber found.
- [secret-set-and-run.md](secret-set-and-run.md): store a secret in the vault and run a program that uses it, without the agent seeing the value.
- [vault-status-reading.md](vault-status-reading.md): what each line of `zn vault status` prints in every vault state, with a fake sample for each.
- [vault-verify-and-forget.md](vault-verify-and-forget.md): the vault verify, forget and purge commands, and what each one asks before acting.
- [zn-secret-allow-vs-approve-decision.md](zn-secret-allow-vs-approve-decision.md): a decision list for `secret allow` and `secret approve`, with the prompts and refusals of each.
- [zn-secret-get-in-a-pipe.md](zn-secret-get-in-a-pipe.md): what `secret get` does when you try to pipe a vault value into another tool, and what to use instead.
- [zn-vault-status-after-unlock-expiry.md](zn-vault-status-after-unlock-expiry.md): read `vault status` before and after the unlock time ran out, see what other commands say, and unlock again.

## Optional cloud check

- [cloud-check-settings.md](cloud-check-settings.md): each setting of the optional cloud check, with its effect and one command.
- [connect-and-disconnect.md](connect-and-disconnect.md): connect, check the status and disconnect the cloud check.
- [first-cloud-check.md](first-cloud-check.md): the shortest path from connect to a first checked prompt, in five steps.
- [long-text-analysis.md](long-text-analysis.md): the two long-input modes of the cloud check, and when the result carries a warning.
- [team-first-day.md](team-first-day.md): the first day of zn Team for a lead and one developer, from the invitation to `zn team leave`.
- [team-managed-config.md](team-managed-config.md): print the managed settings an admin deploys so the hooks run on every machine.
- [team-onboarding-checklist.md](team-onboarding-checklist.md): a one-line-per-step checklist for a new zn Team member, with the expected result and what to do when a step fails.
- [team-sync-after-policy-change.md](team-sync-after-policy-change.md): pull a new team policy version with `zn team sync`, then read what changed in `zn team status`.

## Scripts, CI and APIs

- [ci-secret-scan-gate.md](ci-secret-scan-gate.md): a GitHub Actions job that fails when `zn-gate scan` finds a secret, with the Action and with `npx`.
- [ci-step-example.md](ci-step-example.md): a fake CI job that runs the audit and reads its exit code.
- [node-api.md](node-api.md): a short tour of the Node.js API, with one small example per call.
- [pre-commit-scan.md](pre-commit-scan.md): run `zn-gate scan` on the files of each commit with a git pre-commit hook.
- [python-api.md](python-api.md): five short examples of the Python package.
- [reach-report-file.md](reach-report-file.md): write the reach report to a file in a CI job.
- [scripting.md](scripting.md): use zn-gate from a shell script or a CI job, and read its exit codes.
- [zn-hooks-status-in-a-ci-job.md](zn-hooks-status-in-a-ci-job.md): fail a CI job on `zn-gate check --hooks` when a hook is stale or broken, with its exit codes, real output, and why plain `check` does not catch it.
- [zn-scan-ci-annotations-reading.md](zn-scan-ci-annotations-reading.md): read the GitHub annotations of scan --format github line by line, from the error to the notices and warnings, and silence a fixture folder.
- [zn-why-reading-a-wrapped-block-in-ci-logs.md](zn-why-reading-a-wrapped-block-in-ci-logs.md): find the rule of a block in a CI log whose lines are wrapped, and what zn why can and cannot add.
