# Example: five commands to run after an upgrade

A short list of what to run after you update zn-gate, and what a good result looks like. Run every command in your own terminal, not through an AI agent. For the full steps and the per-release table, read [Upgrading zn-gate](../upgrading.md). The output is described in [Check that it works](../check.md), and every command is in the [command line reference](../cli.md).

## 1. Update the package

```bash
npm install -g zn-gate
```

Add `pip install -U zn-gate` if you use the Python package. If you only run `npx -y zn-gate ...`, there is nothing to update.

A good result: the install finishes without an error.

## 2. Confirm the version

```bash
zn-gate version
```

A good result: it prints the version you expect and the versions of the rules, and exits with `0`. Look up your old and new versions in the [table of releases](../upgrading.md#what-each-release-asks-you-to-do) to see whether the release asks for more.

## 3. Install the hooks again, if the release asks for it

```bash
zn hooks install claude-code   # or codex, cursor, opencode
```

Do this only for an agent that the release notes or the table name. Running it again is safe: it updates zn's own entries and leaves the rest of your settings alone. If you use Codex, open Codex afterwards and approve the changed hooks in `/hooks`.

A good result: the command finishes without an error. If you are not sure whether you need it, run step 4 first: it tells you.

## 4. Run the check

```bash
zn-gate check
```

A good result: every agent that is set up says **OK**, with a line like this:

```text
  OK Claude Code  blocked the .env file and allowed the ordinary file.
```

An agent that is not set up shows `-`, and one that is set up but would not be protected shows `X ... NOT protected`. Both lines print the command that fixes it. The check uses a temporary folder with a fake key, sends nothing and changes no setting. It exits with `0` only when every agent that is set up is protected. See [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## 5. Look at the status

```bash
zn-gate status
```

A good result: it shows the version, the rules version, whether the optional cloud check is on and where the API key comes from. It always exits with `0`, so use `zn-gate check` for the pass or fail answer.
