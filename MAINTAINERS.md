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

## Docs-only pull requests: fewer review rounds

A pull request that changes only documentation is quickest to review when it answers these questions in its description, so the reviewer does not have to ask. The checks themselves are the ones in [Documentation checks](CONTRIBUTING.md#documentation-checks) in CONTRIBUTING.md.

- Commands run: say which of the three documentation checks you ran and paste the last lines of each (pass counts, no errors). If you ran a new or changed command in your own terminal, say on which system and agent.
- Links checked: the docs tests and the offline link check cover relative links and anchors. Say that they passed, and name any external link you opened by hand.
- No new numbers: say that no version, count, price, limit or list of agents changed. If one did, name it and the page or command that it comes from, and say that you ran `node .github/scripts/check-public-facts.mjs`.
- One topic per pull request, and no change to `CHANGELOG.md` by hand. A docs-only change needs no fragment in `changelog.d/`.

## Docs examples index

Every new page in `docs/examples/` must be listed in [docs/examples/README.md](docs/examples/README.md) in the same pull request. Add one line for the page, in alphabetical order.

No CI check enforces this today. The examples checks in CI test the commands on the pages, not the index, so the index is kept by hand. Check it in review.

## For reviewers

A short checklist for a pull request that changes only documentation. It uses the same checks the contributor runs (see "Before you open a pull request" in [CONTRIBUTING.md](CONTRIBUTING.md)). The required checks still have to pass: see [GOVERNANCE.md](GOVERNANCE.md#contributions).

- [ ] The facts match the code. Open the page the text is about and compare: a command or option against [docs/cli.md](docs/cli.md) and `packages/zn-gate/bin/cli.js`, a path or file name against [docs/files-and-folders.md](docs/files-and-folders.md).
- [ ] The commands run. Run each new or changed command in your own terminal. The `docs/examples/` pages only run commands that `docs/cli.md` documents: `node .github/scripts/check-docs-examples-commands.mjs`.
- [ ] The links and anchors resolve. The docs tests check relative links and anchors: from the repository root, `node --test packages/zn-gate/test/docs_*.test.js packages/zn-gate/test/docs-env-vars.test.js packages/zn-gate/test/install_docs_match.test.js`.
- [ ] The public facts are unchanged unless the pull request is about them. Version, agents, license and install command still agree everywhere: `node .github/scripts/check-public-facts.mjs`.
- [ ] No private names. Read the diff and the pull request description for names of people, accounts, machines or local paths that do not belong in a public repository.
- [ ] A change users notice in a package, the plugin or the Action has a fragment in `changelog.d/`; a docs-only change needs none.
