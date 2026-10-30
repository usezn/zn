# zn-gate documentation

An index of the guides in this folder. The main [README](../README.md) is the best place to start.

## Getting started

| Guide | What it covers | For whom |
|---|---|---|
| [First 5 minutes](first-5-minutes.md) | Install zn-gate, see it work, what its messages mean, how to remove it | Anyone who uses a coding agent, no coding needed |
| [zn-gate for beginners](for-beginners.md) | In plain words, what zn-gate does and what it never does | People new to terminal agents |
| [Check that it works](check.md) | What `zn-gate check` prints and how to fix a **NOT protected** line | Everyone, after installing |
| [Keep secrets out of your agent](secrets.md) | Five-minute walkthrough of the vault, markers and `zn run` | Everyone |
| [Recipes](recipes.md) | Ten short step-by-step recipes: install, check, protect a project, connect, report, upgrade, uninstall | Everyone |
| [Troubleshooting](troubleshooting.md) | The messages people meet first, and what to do for each | Everyone |
| [Glossary](glossary.md) | Short meanings of words used in these docs | Newcomers |
| [Upgrading](upgrading.md) | What to do when you update zn-gate | Everyone |
| [Remove zn-gate](uninstall.md) | Uninstall in one step or piece by piece, run from your own terminal | Everyone |
| [First project walkthrough](examples/first-project-walkthrough.md) | One example project from install to uninstall, with fake values | Newcomers |
| [Command line reference](cli.md) | Every command, option and exit code | Everyone |
| [Exit codes](exit-codes.md) | The exit code of every command, on one page | Everyone |
| [Command cheat sheet](commands-cheatsheet.md) | Every command, its main flags and one example, on one page | Everyone |

## Everyday use

| Guide | What it covers | For whom |
|---|---|---|
| [Destructive commands](destructive-commands.md) | Refuses commands that wipe a machine (on by default), and more, such as a download run unread, if you turn them on | Everyone |
| [Network requests that carry personal data](egress-check.md) | Asks you before an agent sends your email address, phone number or a literal secret in a curl, wget, WebFetch or MCP request | Everyone |
| [Protect MCP servers](shield.md) | Wrap an MCP server with the shield, shadow mode and tool pins | Everyone who uses MCP servers |
| [Reach](reach.md) | What the coding agents on your machine can reach (secrets by name, credential files, MCP servers) | Everyone |
| [Report](report.md) | A weekly summary of what zn-gate blocked and hid | Everyone |
| [Examples: stats and report](examples/stats-and-report.md) | Worked examples of `stats` and `report` with sample output | Everyone |
| [Example: Node.js API](examples/node-api.md) | Install and one short example per call of the Node.js API, with fake values | Developers |
| [Audit](audit.md) | Review a repository's agent configuration before you open it | Developers, reviewers |
| [Connect](connect.md) | Turn on the optional cloud check, and turn it off | Anyone who opts in |
| [Agent compatibility](compat.md) | What the scrubber can do in each agent | Everyone choosing or configuring an agent |
| [Editors and coding agents](editors/README.md) | Protection level and two-minute setup per editor | Editor users |
| [Install, verify and uninstall by agent](by-agent.md) | The steps for each supported agent on one page | Editor users |

## Teams and CI

| Guide | What it covers | For whom |
|---|---|---|
| [zn Team](team.md) | Organization policy, audit upload and OpenTelemetry export on a developer machine | Team admins, developers on a team |
| [GitHub Action](github-action.md) | Audit agent configs and scan prompts on every pull request | Maintainers |

## How it works

| Guide | What it covers | For whom |
|---|---|---|
| [Architecture](architecture.md) | The three checks, the local engine and how zn-gate attaches to an agent | Developers, security reviewers |
| [Threat model](threat-model.md) | What the scrubber and broker protect against, and what they do not | Security reviewers |
| [Performance](performance.md) | How long the agent hooks take, with the script to reproduce it | Developers |
| [API reference](api-reference.md) | Node.js and Python functions | Developers |
| [Verify a release](verify-release.md) | Check signatures and build provenance of a download | Security-minded users |
| [Rust gateway (legacy)](rust-core.md) | The original gateway in `src/`, not released | Contributors |

## Security advisories

Published advisories are in [advisories/](advisories/):

- [SEC-2026-01](advisories/SEC-2026-01.md): control-plane authorization gap in the management API of the legacy gateway.
- [SEC-2026-02](advisories/SEC-2026-02.md): session and token revocation on password reset in the usezn.com platform.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Diagrams

The diagrams used in the README and these guides are in [diagrams/](diagrams/), each with an editable `.excalidraw` source and a [notice](diagrams/NOTICE.md) for the fonts and icons they embed.
