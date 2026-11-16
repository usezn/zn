# Package install check walkthrough: one question about a look-alike name

This page turns on the optional package install check, follows one fake request from an agent to install a look-alike package, and shows the question, the answer, the allow list and the decision log. The package names are made up. For the full behaviour, read [Packages your agent installs](../package-install-check.md).

## Turn it on

The check is off by default. Set `hooks.packageInstallCheck` in `~/.zn/config.json`:

```json
{"hooks": {"packageInstallCheck": "offline"}}
```

`"offline"` compares each package name with a list of well-known package names that ships with zn-gate, and nothing is sent anywhere. The environment variable `ZN_PACKAGE_CHECK=offline` turns on the offline mode for one shell.

## The request

Your agent decides it needs a package and runs:

```bash
npm install lodahs
```

`lodahs` is not a real package. It is one small step from the well-known `lodash`: two letters swapped. The offline check reads the command text and reports the name.

## What you see

Your agent asks you to approve or refuse the install. The question names the package and, for a look-alike, the name it may have been meant to be:

> zn: this command installs a package that needs a second look: npm package `lodahs` looks like the well-known `lodash` (did you mean `lodash`?). Names that copy popular packages are used to spread malware, and an agent can make up a name that does not exist. Approve it only if this is the package you want. To stop this question for a name, add it to hooks.packageInstallAllow in ~/.zn/config.json.

## How to answer

Approve the install only if this is the package you want; otherwise refuse it. In this example the name the agent may have meant is `lodash`.

The question never blocks a command by itself. Two cases where nobody answers:

- Agents that cannot show a question (Codex CLI, OpenCode and Gemini CLI) run the command; the finding is still written to the decision log.
- Where nobody is there to answer, for example Claude Code with `claude -p`, the agent treats a question as a refusal, as it does for every other question from zn-gate.

## Allow a name

To stop this question for a name, add it to `hooks.packageInstallAllow` in `~/.zn/config.json`. An entry is a package name (`my-tool`), and `@scope/*` covers a whole npm scope. PyPI names are compared after the normalisation PyPI itself applies.

```json
{"hooks": {"packageInstallAllow": ["my-tool", "@my-company/*"]}}
```

## Where the decision is recorded

Each question is written to the decision log (`~/.zn/evidence.jsonl`) as an `allow` record with one of these rules: `hook-package-check-look-alike` (this example), `hook-package-check-not-found`, `hook-package-check-new` and `hook-package-check-unavailable`. The record names the package and never holds the command.

## Where to go next

- [Packages your agent installs](../package-install-check.md), the full page: every setting, what is checked, what leaves your computer and the limits.
