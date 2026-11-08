# Examples

Worked examples, in alphabetical order. All values in them are made up.

- [audit-before-adding-a-repo.md](audit-before-adding-a-repo.md): run `zn-gate audit` on a repository you do not know yet, read the report and decide what to do before you open it with an agent.
- [block-message-anatomy.md](block-message-anatomy.md): one real block message, explained part by part.
- [egress-check.md](egress-check.md): a short walk-through of the egress check with fake hosts.
- [first-block-vs-allow-decision.md](first-block-vs-allow-decision.md): what to do the first time zn-gate blocks a command of your agent, and when to change the settings instead.
- [env-file-round-trip.md](env-file-round-trip.md): move a fake `.env` file into the vault and put the values back.
- [first-cloud-check.md](first-cloud-check.md): the shortest path from connect to a first checked prompt, in five steps.
- [first-project-walkthrough.md](first-project-walkthrough.md): one small example project, from install to removal.
- [init-and-uninstall.md](init-and-uninstall.md): set up zn-gate, preview the steps with a dry run, then remove it.
- [long-text-analysis.md](long-text-analysis.md): the two long-input modes of the cloud check (`windows` or `off`), and when the result carries a warning.
- [mcp-server-with-zn-gate.md](mcp-server-with-zn-gate.md): the two MCP servers of zn-gate (`mcp` and `secrets-mcp`): what each does and what the agent sees.
- [package-install-check-walkthrough.md](package-install-check-walkthrough.md): turn on the optional package install check, answer one question about a look-alike name, then allow a name.
- [reading-a-reach-history-report.md](reading-a-reach-history-report.md): how to read the output of zn-gate reach --history.
- [scan-walkthrough.md](scan-walkthrough.md): scan one small example project, from the run to what each exit code means.
- [stats-and-report.md](stats-and-report.md): worked examples of `zn-gate stats` and `zn-gate report`.
- [which-command-shows-what.md](which-command-shows-what.md): one table with six common questions and the command that answers each.
- [zn-scan-package-reading.md](zn-scan-package-reading.md): read the output of `zn-gate scan --package` for a package with nothing found, a package with a finding and a package that does not exist.
- [zn-why-allow-command.md](zn-why-allow-command.md): read the output of `zn why`, then run the one command it gives you to allow a blocked action.
