# Governance

This document describes how the zn project (this repository, `usezn/zn`, and the
`zn-gate` packages built from it) is maintained, how decisions are made, how
releases are published and how contributions are accepted.

## Maintainers

The project is maintained by the people listed in [MAINTAINERS.md](MAINTAINERS.md).
Today there is one maintainer, who:

- reviews and merges pull requests;
- decides on the roadmap and on what goes into each release;
- prepares, approves and publishes releases;
- handles security reports and coordinates their disclosure (see [SECURITY.md](SECURITY.md));
- administers the GitHub organization, the repository settings and the package
  registry entries (npm, PyPI and the MCP Registry).

The project is developed under the usezn name, which also runs the optional zn
cloud service. The code in this repository is MIT-licensed and works without
that service.

## How decisions are made

- Day-to-day changes are decided in pull requests: anyone can open one, and the
  discussion happens in the pull request or in the issue it links.
- Larger changes (a new command, a change of default behaviour, a new runtime
  dependency, anything that changes what leaves the user's machine) start as an
  issue or a draft pull request describing the problem and the proposal, so
  others can comment before the work is done.
- The maintainers make the final decision. When they decline a proposal, they
  say why in the issue or pull request.
- Security-sensitive decisions are discussed privately until a fix is released
  (see [SECURITY.md](SECURITY.md)).

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | What is published. Every release is cut from `main` or from a `release/X.Y.Z` branch made from it. |
| `next` | Integration branch. Pull requests target `next`. |
| `release/X.Y.Z` | A release being prepared: a version bump, release notes and, for a patch release, only the fixes it ships. |

`main` and `next` are protected: changes go through pull requests, the required
CI checks must pass (Node.js 18, 22 and 24 test suites, Python tests, the npm and
Python package checks, the secret-leak benchmark and the scrubber and vault
tests), and force pushes and deletion are blocked. `release/*` branches and
`v*` tags can only be created by repository administrators (today, the
maintainer); they cannot be force-pushed or deleted, and tags cannot be moved.
Administrators can bypass the release branch and tag rules. A release branch
reaches `main` only through a pull request with the required checks.

## Contributions

- Open pull requests against `next`. Keep each one focused on one change, with
  tests, and add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md)
  for anything a user would notice.
- Pull requests from contributors are reviewed by a maintainer before they are
  merged, and the required CI checks must pass. With a single maintainer today,
  the maintainer's own pull requests are merged once the required checks pass
  (GitHub does not allow approving your own pull request). Changes to detection
  rules must keep the Node.js and Python rule sets in step (see
  [CONTRIBUTING.md](CONTRIBUTING.md)).
- Pull requests that touch `.github/workflows/`, the release tooling or the
  supply chain (dependencies, lockfiles, pinned actions) are reviewed with extra
  care for what they run and with which permissions.
- Commits are not force-pushed to shared branches; history is kept.
- Report security issues privately, never in a public issue or pull request (see
  [SECURITY.md](SECURITY.md)).

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE) of this repository.

## Releases

Releases follow [Semantic Versioning](https://semver.org/). Prereleases use
`-alpha.N`, `-beta.N` and `-rc.N`.

1. A maintainer prepares the release on a `release/X.Y.Z` branch made from
   `main`: version numbers in every package and the `## [X.Y.Z]` section of the
   changelog, with a pull request into `main` that must pass the required CI
   checks.
2. A maintainer pushes an annotated tag `vX.Y.Z` on that commit (see Branches
   for who can create tags).
3. The [`Release` workflow](.github/workflows/release.yml) builds the npm package
   and the Python distributions once, from the tag, and checks that the tag, the
   package versions and the branch match.
4. The workflow waits in the protected `release` environment. A maintainer checks
   the run and approves it, then:
   - the files are signed with Sigstore and get GitHub build provenance attestations;
   - the same files are published to npm and PyPI with trusted publishing (no
     long-lived tokens), with npm provenance and PyPI attestations;
   - a GitHub Release is created with the files, `SHA256SUMS` and the signature
     bundles (as a draft for final versions, which the maintainer reviews and
     publishes).
5. The MCP Registry entry is published by the `MCP Registry` workflow, from `main`,
   after another approval in the protected `mcp-registry` environment.
6. The release pull request is merged into `main`, and `main` is merged back
   into `next`.

How to verify a release: [docs/verify-release.md](docs/verify-release.md).

## Adding maintainers

The project wants more maintainers. A contributor can be invited to become a
maintainer after a sustained record of good contributions and reviews, an
understanding of the security model ([docs/threat-model.md](docs/threat-model.md)),
and agreement to follow this document and [SECURITY.md](SECURITY.md).

The existing maintainers decide on the invitation. New maintainers are added to
[MAINTAINERS.md](MAINTAINERS.md) in a pull request and get access step by step:
review rights first, then merge rights, then release approval. Maintainers who
stop being active may step down or be moved to an emeritus list.

## Account security

The `usezn` GitHub organization requires two-factor authentication for all
members, outside collaborators and billing managers, and allows only secure
methods: authenticator apps, passkeys, security keys and GitHub Mobile. SMS is
not accepted, and an account that still has SMS configured is treated as
non-compliant. Invitations can only be accepted after a secure method is set
up. Members who are not compliant cannot access the organization's
repositories or other resources until they fix it, and outside collaborators
who are not compliant are removed.

## Changes to this document

Changes to this document are made in a pull request and decided by the maintainers.
