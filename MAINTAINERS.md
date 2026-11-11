# Maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| John Silver | [@tljohnsilver](https://github.com/tljohnsilver) | Lead maintainer: reviews and merges, releases, security response |

Security reports: [security@usezn.com](mailto:security@usezn.com) or GitHub private
vulnerability reporting (see [SECURITY.md](SECURITY.md)).

How maintainers work and how new ones are added: [GOVERNANCE.md](GOVERNANCE.md).

## For reviewers

A short checklist for a pull request that changes only documentation. It uses the same checks the contributor runs (see "Before you open a pull request" in [CONTRIBUTING.md](CONTRIBUTING.md)). The required checks still have to pass: see [GOVERNANCE.md](GOVERNANCE.md#contributions).

- [ ] The facts match the code. Open the page the text is about and compare: a command or option against [docs/cli.md](docs/cli.md) and `packages/zn-gate/bin/cli.js`, a path or file name against [docs/files-and-folders.md](docs/files-and-folders.md).
- [ ] The commands run. Run each new or changed command in your own terminal. The `docs/examples/` pages only run commands that `docs/cli.md` documents: `node .github/scripts/check-docs-examples-commands.mjs`.
- [ ] The links and anchors resolve. The docs tests check relative links and anchors: `cd packages/zn-gate`, then `node --test test/docs_*.test.js`.
- [ ] The public facts are unchanged unless the pull request is about them. Version, agents, license and install command still agree everywhere: `node .github/scripts/check-public-facts.mjs`.
- [ ] No private names. Read the diff and the pull request description for names of people, accounts, machines or local paths that do not belong in a public repository.
- [ ] A change users notice in a package, the plugin or the Action has a fragment in `changelog.d/`; a docs-only change needs none.
