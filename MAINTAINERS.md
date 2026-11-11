# Maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| John Silver | [@tljohnsilver](https://github.com/tljohnsilver) | Lead maintainer: reviews and merges, releases, security response |

## Before you open an issue

Reports are triaged faster when these are done. A maintainer can ask for any that is missing. A question or an idea belongs in [Discussions](https://github.com/usezn/zn/discussions), and a security problem never in an issue (see below).

- [ ] Look for your symptom in the [troubleshooting page](docs/troubleshooting.md#symptom-index), and search the existing issues for the same problem.
- [ ] Run `npx -y zn-gate check` in your own terminal (its other name is `doctor`) and note the line of your agent. [What the output means](docs/check.md).
- [ ] Run `npx -y zn-gate check --json` and paste the result. It has no secret values, and your home folder is shown as `~`.
- [ ] Give the zn-gate version: the output of `npx -y zn-gate version`, or the `zn_gate_version` field of the JSON.
- [ ] Say which operating system and which agent you use, and the agent version if you know it ([where to find it](docs/compat.md#where-to-find-your-agent-version)).
- [ ] Write the exact steps, what you expected and what happened.
- [ ] Remove every key, token, password and personal detail from what you paste. Never paste the content of a `.env` file.

The same list, with what each command prints, is in [what to run and paste before asking for help](docs/examples/doctor-before-asking-for-help.md). The [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml) asks for the same details.

Security reports: [security@usezn.com](mailto:security@usezn.com) or GitHub private
vulnerability reporting (see [SECURITY.md](SECURITY.md)).

How maintainers work and how new ones are added: [GOVERNANCE.md](GOVERNANCE.md).
