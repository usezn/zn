# zn-gate documentation

An index of the guides in this folder. The main [README](../README.md) is the best place to start.

## Which page do I read

| I want to... | Read |
|---|---|
| Install zn-gate and see it work | [First 5 minutes](first-5-minutes.md) |
| Check that I am protected | [Check that it works](check.md) |
| Keep my API keys and `.env` values away from my agent | [Keep secrets out of your agent](secrets.md) |
| Set it up for my editor or coding agent | [Editors and coding agents](editors/README.md) or [OpenCode](editors/opencode.md), or [Install, verify and uninstall by agent](by-agent.md) |
| Understand a word or a message I do not know | [Glossary](glossary.md) and [Troubleshooting](troubleshooting.md) |
| Look up a command, option or exit code | [Command line reference](cli.md) and [Exit codes](exit-codes.md) |
| Review a repository's agent settings before I open it | [Audit](audit.md) |
| Stop a coding agent in CI from exposing secrets | [Coding agents in CI](agents-in-ci.md) and the [GitHub Action](github-action.md) |
| Set a shared policy for my team | [zn Team](team.md) and the [Team quick guide](team-quick-guide.md) |
| Update or remove zn-gate | [Upgrading](upgrading.md) and [Remove zn-gate](uninstall.md) |
| Call zn-gate from Node.js or Python | [API reference](api-reference.md) |
| Know what zn-gate does and does not protect against | [Threat model](threat-model.md) |

The full list of guides follows below. If a word is unfamiliar, see the [Glossary](glossary.md).

## Getting started

| Guide | What it covers | For whom |
|---|---|---|
| [First 5 minutes](first-5-minutes.md) | Install zn-gate, see it work, what its messages mean, how to remove it | Anyone who uses a coding agent, no coding needed |
| [zn-gate for beginners](for-beginners.md) | In plain words, what zn-gate does and what it never does | People new to terminal agents |
| [Check that it works](check.md) | What `zn-gate check` prints and how to fix a **NOT protected** line | Everyone, after installing |
| [Keep secrets out of your agent](secrets.md) | Five-minute walkthrough of the vault, markers and `zn run` | Everyone |
| [Recipes](recipes.md) | Eleven short step-by-step recipes: install, check, protect a project, connect, report, upgrade, uninstall | Everyone |
| [Troubleshooting](troubleshooting.md) | The messages people meet first, and what to do for each | Everyone |
| [Why was this blocked?](why-was-this-blocked.md) | Five common blocks, what each message means and how to go on safely | Everyone |
| [Glossary](glossary.md) | Short meanings of words used in these docs | Newcomers |
| [FAQ: update and remove zn-gate](faq.md) | Short answers to common questions about updating and removing zn-gate | Everyone |
| [Upgrading](upgrading.md) | What to do when you update zn-gate | Everyone |
| [Remove zn-gate](uninstall.md) | Uninstall in one step or piece by piece, run from your own terminal | Everyone |
| [First project walkthrough](examples/first-project-walkthrough.md) | One example project from install to uninstall, with fake values | Newcomers |
| [Example: Python package first run](examples/python-only-first-run.md) | From `pip install zn-gate` to a blocked fake secret, without Node.js | Python developers |
| [Install matrix](install-matrix.md) | Install methods by operating system, with the command that verifies each one | Everyone |
| [Command line reference](cli.md) | Every command, option and exit code | Everyone |
| [Exit codes](exit-codes.md) | The exit code of every command, on one page | Everyone |
| [Command cheat sheet](commands-cheatsheet.md) | Every command, its main flags and one example, on one page | Everyone |

## Everyday use

| Guide | What it covers | For whom |
|---|---|---|
| [Destructive commands](destructive-commands.md) | Refuses commands that wipe a machine (on by default), and more, such as a download run unread, if you turn them on | Everyone |
| [Packages your agent installs](package-install-check.md) | Optional and off by default: asks you before an agent installs a package whose name looks like a well-known one, or (online mode) does not exist or is brand new. Never blocks | Everyone |
| [Network requests that carry personal data](egress-check.md) | Asks you before an agent sends your email address, phone number or a literal secret in a curl, wget, WebFetch or MCP request | Everyone |
| [Protect MCP servers](shield.md) | Wrap an MCP server with the shield, shadow mode and tool pins | Everyone who uses MCP servers |
| [Reach](reach.md) | What the coding agents on your machine can reach (secrets by name, credential files, MCP servers) | Everyone |
| [Report](report.md) | A weekly summary of what zn-gate blocked and hid | Everyone |
| [Examples: stats and report](examples/stats-and-report.md) | Worked examples of `stats` and `report` with sample output | Everyone |
| [Code examples](../examples/README.md) | Index of the 20 runnable examples, with the command to run each one | Developers |
| [Example: reading a scan finding](examples/reading-a-scan-finding.md) | What each field of a `zn-gate scan` finding means, with a fake finding | Everyone |
| [Example: Node.js API](examples/node-api.md) | Install and one short example per call of the Node.js API, with fake values | Developers |
| [API quickstart](api-quickstart.md) | Send text to the analysis API from curl, Python or Node.js, with the key in an environment variable | Developers |
| [Example: cloud check settings](examples/cloud-check-settings.md) | Each cloud check setting with its effect, one fake command and what leaves the machine | Anyone who opts in |
| [Audit](audit.md) | Review a repository's agent configuration before you open it | Developers, reviewers |
| [Connect](connect.md) | Turn on the optional cloud check, and turn it off | Anyone who opts in |
| [Files and folders](files-and-folders.md) | The files and folders that zn-gate reads or writes, such as the `.zn` folder | Everyone |
| [Agent compatibility](compat.md) | What the scrubber can do in each agent | Everyone choosing or configuring an agent |
| [Editors and coding agents](editors/README.md) | Protection level and two-minute setup per editor | Editor users |
| [Install, verify and uninstall by agent](by-agent.md) | The steps for each supported agent on one page | Editor users |

## Worked examples

More short walk-throughs in [examples/](examples/), all with fake values:

- [After an upgrade](examples/after-an-upgrade.md): five commands to run after you update zn-gate.
- [Check output explained](examples/check-output-explained.md): a sample `check` output, line by line.
- [Init and uninstall](examples/init-and-uninstall.md): set up zn-gate, preview, then remove it.
- [Offline and local only](examples/offline-and-local-only.md): use zn-gate with no network and with the cloud check off.
- [Python API](examples/python-api.md): five short examples of the Python package.
- [Reach report file](examples/reach-report-file.md): write the reach report to a file in CI.
- [Scripting](examples/scripting.md): exit codes and JSON output in a shell script and a CI job.
- [Uninstall one agent](examples/uninstall-one-agent.md): remove zn-gate from one agent and keep the others.
- [Unix first run](examples/unix-first-run.md): the first ten minutes on macOS or Linux with a version-manager Node.js.
- [Upgrade checklist](examples/upgrade-checklist.md): a one-screen version of the upgrade steps.
- [Windows checklist](examples/windows-checklist.md): install and check zn-gate on Windows.
- [Zed and JetBrains](examples/zed-and-jetbrains.md): connect, check and remove zn-gate in Zed and JetBrains.

## Teams and CI

| Guide | What it covers | For whom |
|---|---|---|
| [zn Team](team.md) | Organization policy, audit upload and OpenTelemetry export on a developer machine | Team admins, developers on a team |
| [GitHub Action](github-action.md) | Audit agent configs and scan prompts on every pull request | Maintainers |
| [Coding agents in CI](agents-in-ci.md) | Run an agent in a workflow without letting an issue or a pull request expose your secrets, with a hardened example | Maintainers |

## How it works

| Guide | What it covers | For whom |
|---|---|---|
| [Architecture](architecture.md) | The three checks, the local engine and how zn-gate attaches to an agent | Developers, security reviewers |
| [Threat model](threat-model.md) | What the scrubber and broker protect against, and what they do not | Security reviewers |
| [What runs locally and what goes to the API](local-checks-and-api-data.md) | Which checks run on your computer, when the optional cloud check is called, the exact request it sends, and how to keep everything local | Everyone |
| [Hardware-backed vault key (proposal)](hardware-backed-vault-key.md) | An idea for tying the vault key to a security key, TPM or Secure Enclave; not built | Security reviewers |
| [OWASP mapping](owasp-mapping.md) | Which zn-gate rules and features touch each category of the OWASP LLM and MCP Top 10, what is not covered, and the agent CVEs that `zn audit` reports | Security reviewers |
| [Performance](performance.md) | How long the agent hooks take, with the script to reproduce it | Developers |
| [API reference](api-reference.md) | Node.js and Python functions | Developers |
| [API data handling](api-data-handling.md) | What the analysis API keeps, for how long, and how to delete it | Developers, security reviewers |
| [Verify a release](verify-release.md) | Check signatures and build provenance of a download | Security-minded users |
| [Rust gateway (legacy)](rust-core.md) | The original gateway in `src/`, not released | Contributors |

## Security advisories

Published advisories are in [advisories/](advisories/):

- [SEC-2026-01](advisories/SEC-2026-01.md): control-plane authorization gap in the management API of the legacy gateway.
- [SEC-2026-02](advisories/SEC-2026-02.md): session and token revocation on password reset in the usezn.com platform.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Diagrams

The diagrams used in the README and these guides are in [diagrams/](diagrams/), each with an editable `.excalidraw` source and a [notice](diagrams/NOTICE.md) for the fonts and icons they embed.

## Where to ask for help

| You have | Go to |
|---|---|
| A question about setup or use, or an idea | [GitHub Discussions](https://github.com/usezn/zn/discussions) |
| A bug you can reproduce, or a concrete feature request | [GitHub issues](https://github.com/usezn/zn/issues) |
| A message from zn-gate you do not understand | [Troubleshooting](troubleshooting.md) and [Why was this blocked?](why-was-this-blocked.md) |
| A security vulnerability | Report it privately as described in [SECURITY.md](../SECURITY.md). Do not post it in Discussions or issues. |

More about these channels is in [Community and support](../README.md#community-and-support). To contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md).
