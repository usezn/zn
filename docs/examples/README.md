# Examples

Worked examples, in alphabetical order. All values in them are made up.

- [audit-before-adding-a-repo.md](audit-before-adding-a-repo.md): run `zn-gate audit` on a repository you do not know yet, read the report and decide what to do before you open it with an agent.
- [block-message-anatomy.md](block-message-anatomy.md): one real block message, explained part by part.
- [claude-code-plugin-or-cli.md](claude-code-plugin-or-cli.md): the two ways to cover Claude Code (the plugin, or the hooks of `zn hooks install claude-code`), what each needs, and how to verify and remove them.
- [egress-check.md](egress-check.md): a short walk-through of the egress check with fake hosts.
- [env-file-round-trip.md](env-file-round-trip.md): move a fake `.env` file into the vault and put the values back.
- [first-block-vs-allow-decision.md](first-block-vs-allow-decision.md): what to do the first time zn-gate blocks a command of your agent, and when to change the settings instead.
- [first-cloud-check.md](first-cloud-check.md): the shortest path from connect to a first checked prompt, in five steps.
- [first-project-walkthrough.md](first-project-walkthrough.md): one small example project, from install to removal.
- [hook-subcommand-explained.md](hook-subcommand-explained.md): what `zn-gate hook` is, who calls it, and why you rarely run it by hand.
- [hooks-uninstall-then-verify.md](hooks-uninstall-then-verify.md): remove zn's hooks and confirm with `zn-gate check --hooks` that none is left.
- [init-and-uninstall.md](init-and-uninstall.md): set up zn-gate, preview the steps with a dry run, then remove it.
- [long-text-analysis.md](long-text-analysis.md): the two long-input modes of the cloud check (`windows` or `off`), and when the result carries a warning.
- [mcp-pin-review-checklist.md](mcp-pin-review-checklist.md): what to compare in a changed MCP tool before you approve it with `pins approve`.
- [mcp-server-with-zn-gate.md](mcp-server-with-zn-gate.md): the two MCP servers of zn-gate (`mcp` and `secrets-mcp`): what each does and what the agent sees.
- [package-install-check-walkthrough.md](package-install-check-walkthrough.md): turn on the optional package install check, answer one question about a look-alike name, then allow a name.
- [reading-a-reach-history-report.md](reading-a-reach-history-report.md): how to read the output of zn-gate reach --history.
- [safe-first-day-with-a-new-agent.md](safe-first-day-with-a-new-agent.md): try zn-gate with a new agent in a throwaway folder, then remove it.
- [scan-a-single-file.md](scan-a-single-file.md): scan one file instead of a folder, and read the report.
- [scan-walkthrough.md](scan-walkthrough.md): scan one small example project, from the run to what each exit code means.
- [secret-adopt-existing-file.md](secret-adopt-existing-file.md): adopt a secret that zn-gate found in a project file, from the token it was replaced with to a named vault secret, and the check afterwards.
- [shield-walkthrough.md](shield-walkthrough.md): wrap a fake MCP server with the shield, from shadow mode to enforce and back.
- [stats-and-report.md](stats-and-report.md): worked examples of `zn-gate stats` and `zn-gate report`.
- [team-onboarding-checklist.md](team-onboarding-checklist.md): a one-line-per-step checklist for a new zn Team member, with the expected result and what to do when a step fails.
- [vault-log-export.md](vault-log-export.md): export the vault audit log as OpenTelemetry logs.
- [vault-verify-and-forget.md](vault-verify-and-forget.md): the vault verify, forget and purge commands, and what each one asks before acting.
- [which-command-shows-what.md](which-command-shows-what.md): one table with six common questions and the command that answers each.
- [zn-hooks-install-for-one-agent.md](zn-hooks-install-for-one-agent.md): install the hooks for one coding agent only, then verify them with `check --hooks` and `check`.
- [zn-why-allow-command.md](zn-why-allow-command.md): read the output of `zn why`, then run the one command it gives you to allow a blocked action.
