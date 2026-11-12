# Example: run check on a fresh clone of a repository

You cloned a repository and you have not opened it with your coding agent yet. This page shows what `zn check` tells you in that folder, what it does not touch, and how `zn scan` adds a look at the files of the clone. zn-gate is already set up for your user (see [First 5 minutes](../first-5-minutes.md)). The repository, its folder name and its values are made up. Run the commands in your own terminal, not through an AI agent. Every command is in the [command reference](../cli.md).

## 1. Clone and go in

```bash
git clone https://example.com/example-org/example-repo.git
cd example-repo
```

The address is made up (`example.com` hosts no repository): use a repository of your own. If you want a review of the agent settings the repository ships before an agent reads them, run `zn audit` first, as in [audit a repository before you open it](audit-before-opening.md).

## 2. Run the check

```bash
zn check
```

```text
zn-gate check: does zn stop your coding agent from reading a secret?

zn made a test folder with a fake key in a .env file and an ordinary file next to it, then asked
each agent's zn hook whether the agent may read them. This is what happened:

  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). ..."
  -  Codex CLI    not found on this machine
  ...

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
```

This is a real run, cut at the dots. What it tells you for the clone:

- **`OK`** means the hooks you installed for your user stop the agent from reading a `.env` file. Your user settings apply to every folder, so they apply to this clone too, with nothing more to install.
- **The test runs in a temporary folder.** `zn check` does not read the `.env` file of the repository. It deletes its own folder at the end ("The test folder was deleted") and changes no setting. In a test run, the `.env` file of the clone and `git status` were the same before and after.
- **`-` and `NOT protected`.** An agent that is on your machine but has no zn hooks gets a line like this one, and `check` then exits with `1`:

  ```text
    -  Codex CLI    zn is not set up for this agent. To protect it, run `zn hooks install codex` in your own terminal.
  ```

  Run the command it gives before you open the clone with that agent. See [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## 3. When the repository ships its own hook file

A repository can hold agent settings of its own, for example `.claude/settings.json`. `zn check` reads that file in the folder you are in, but it never runs it. If it holds a zn hook that is not written the way zn writes it, the `OK` line gets a note. Here the repository's file has a bare `zn hook claude-code` command (the path is shortened):

```text
  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: .env holds plain-text secrets, ..."
     (the hook in example-repo/.claude/settings.json is a bare `zn hook claude-code`: where zn or Node.js cannot start, Claude Code runs the call unchecked there; run `zn hooks install claude-code --project` again in that project (it writes the guarded command))
```

The note says what to do: run `zn hooks install claude-code --project` from the folder that holds the file, which replaces the command with the exact one zn writes. That edits a file of the repository, so only do it in a repository you may change. The other notes of this kind are in [The hooks are set up but cannot run](../check.md#the-hooks-are-set-up-but-cannot-run).

## 4. When the repository has rules that cannot be read

A repository can hold zn rules of its own in `.znrules` or `zn.config.json`. If that file has an error, zn blocks until it is fixed, and `zn check` says so and exits with `1`. A test file with one unclosed group gave:

```text
Project rules: .znrules has 1 error, so zn-gate blocks until it is fixed:
  - line 2: a group is not closed
Edit .znrules or delete it.
```

## 5. Scan the files of the clone

`check` looks at your setup, not at the files of the repository. To look for secrets in the files, run the scan in the same folder:

```bash
zn scan
```

For a clone with a `.env` file that holds two fake AWS keys, the report looks like this:

```text
Findings (2):
  [x] .env:1 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]
    Next: run npx -y zn-gate env shadow .env to move the values into the local vault, and rotate any value that was ever committed or shared.
  ...
Audit Result : FAILED - 2 SECRET(S) FOUND
```

The scan exited with `1` because it found a secret. The line shows the key with the value replaced, and the `Next:` line says what to do. Read the [Scan walkthrough](scan-walkthrough.md) for every part of the report and for the exit codes, and [Scan a single file](scan-a-single-file.md) when you only care about one file.

## More

- [Check that it works](../check.md)
- [Audit a repository before you open it](audit-before-opening.md)
- [Scan walkthrough](scan-walkthrough.md)
- [`check` and `scan` in the command reference](../cli.md)
