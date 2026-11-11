# Maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| John Silver | [@tljohnsilver](https://github.com/tljohnsilver) | Lead maintainer: reviews and merges, releases, security response |

Security reports: [security@usezn.com](mailto:security@usezn.com) or GitHub private
vulnerability reporting (see [SECURITY.md](SECURITY.md)).

How maintainers work and how new ones are added: [GOVERNANCE.md](GOVERNANCE.md).

## Docs-only pull requests: fewer review rounds

A pull request that changes only documentation is quickest to review when it answers these questions in its description, so the reviewer does not have to ask. The checks themselves are the ones in [Documentation checks](CONTRIBUTING.md#documentation-checks) in CONTRIBUTING.md.

- Commands run: say which of the three documentation checks you ran and paste the last lines of each (pass counts, no errors). If you ran a new or changed command in your own terminal, say on which system and agent.
- Links checked: the docs tests and the offline link check cover relative links and anchors. Say that they passed, and name any external link you opened by hand.
- No new numbers: say that no version, count, price, limit or list of agents changed. If one did, name it and the page or command that it comes from, and say that you ran `node .github/scripts/check-public-facts.mjs`.
- One topic per pull request, and no change to `CHANGELOG.md` by hand. A docs-only change needs no fragment in `changelog.d/`.
