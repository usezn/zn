# Maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| John Silver | [@tljohnsilver](https://github.com/tljohnsilver) | Lead maintainer: reviews and merges, releases, security response |

Security reports: [security@usezn.com](mailto:security@usezn.com) or GitHub private
vulnerability reporting (see [SECURITY.md](SECURITY.md)).

How maintainers work and how new ones are added: [GOVERNANCE.md](GOVERNANCE.md).

## Reviewing documentation pull requests

- Open the pull request against the `next` branch, not `main`.
- A change that only touches a page under `docs/` or a README does not need a changelog fragment. Only changes to shipped files do (see [changelog.d/README.md](changelog.d/README.md)).
- Run the three documentation checks in [CONTRIBUTING.md](CONTRIBUTING.md#documentation-checks) before you ask for a review.
- A draft pull request does not start the required checks, except Public facts. Mark it as ready for review to start them.
- The repository has no CODEOWNERS file, so no reviewer is assigned automatically. The lead maintainer above reviews and merges. Merging needs a maintainer review and the required checks to pass ([GOVERNANCE.md](GOVERNANCE.md)).
