# Glossary

Short meanings of words used in the zn-gate docs.

**Coding agent**: a program such as Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot, or the experimental Gemini CLI that reads your files and runs commands for you.

**Terminal**: the window where you type commands. Run zn-gate's setup commands in your own terminal, not through an agent.

**Node.js**: the program that runs zn-gate's npm commands. `npx` comes with it. You can get it at [nodejs.org](https://nodejs.org/).

**Secret**: a value that gives access to something, such as an API key, a token or a password.

**`.env` file**: a file in a project that holds secrets and other settings for your app.

**Vault**: an encrypted store on your machine where zn-gate keeps the real values of your secrets.

**Marker**: a stand-in for a secret, such as `__ZN_STRIPE_KEY__`. Your agent sees the marker. The real value stays in the vault. A marker is filled in for web requests and files, never in a command's arguments.

**Redact**: replace a secret in some text with a marker or a label, so nobody who reads the text sees the value.

**Shadow** (`env shadow`): move the secret values of a `.env` file into the vault and leave markers in their place.

**Hook**: a small check that your agent runs before or after it reads a file, runs a command or gets your prompt. zn-gate uses hooks to block or redact.

**Plugin**: the zn-gate add-on for Claude Code. It sets up zn-gate's hooks in one step; since version 1.14.0 it adds no MCP server.

**MCP server**: a tool your agent can call. MCP is the standard way agents connect to tools. zn-gate can also run as one.

**Proxy** (`shield`): a layer that sits between your agent and an MCP server and checks what passes through.

**Prompt injection**: text that tries to make an agent ignore your instructions, for example hidden inside a file or a web page.

**Keychain**: the password store of your operating system.

**Cloud check**: an optional second check, by the Galvanize 3 classifier at usezn.com, of the text sent to zn-gate's `analyze_prompt` tool. It is off until you turn it on. Its figures (recall, false positives) describe that classifier, not zn-gate's local rules.

**Classifier**: a model that sorts text into groups, such as safe or an injection attempt.

**Self-test**: `zn-gate test`. It runs zn-gate's built-in examples.

**Exit code**: the number a command returns when it ends. `0` means success; other numbers say what went wrong. The codes of each command are in the [command line reference](cli.md#exit-codes).

**Alias**: another name for the same command, for example `doctor` for `check`.

**Dry run** (`--dry-run`): show what a command would change, and change nothing.

**API key**: a secret that identifies you to an online service. zn-gate needs one only for the [cloud check](connect.md), and it is never needed for the local checks.

**Scrubber**: the part of zn-gate that finds secret values in text, such as a tool's output, and redacts them. See [Secrets](secrets.md).

**Broker**: the part of zn-gate that uses a secret for a command on your behalf, so the agent never sees the value. `zn-gate run` is the broker's command.

**Placeholder**: another word for a marker, as in `__ZN_` placeholders.

**Allowed hosts and commands**: the policy of a secret. It lists the hosts and commands that may use the secret. Any other use is refused.

**Token map**: the list of which marker stands for which value in one project. `vault forget` removes it.

**Passphrase**: the password that protects your vault. If you lose it, `vault reset` is the way out: it starts a new, empty vault.

**Lock and unlock**: while the vault is locked, nobody can read secrets from it. `unlock` opens it for a limited time; `lock` closes it at once.

**Pin** (`pins`): the saved description of the tools of an MCP server. When a tool changes later, `shield` notices and waits until you approve it.

**Wrap** (`init --wrap-mcp`): change an agent's MCP server entry so that the server starts through `shield`.

**Stdio**: standard input and output, the plain text channels of a program. MCP servers started by an agent talk over them.

**Marketplace**: a catalog from which Claude Code installs plugins. You add the zn marketplace once, then install the zn-gate plugin from it.

**PATH entry**: a folder in the list your terminal searches for commands. If the folder with `zn-gate` is not on the list, the terminal says the command is not found.

**Project root**: the top folder of your project, usually the one that holds `.git`. zn-gate looks for project settings and the `.env` file there.

**Worktree**: an extra working folder of the same Git repository, with its own checked-out branch. Agents often use one to work apart from your main copy.

**Release candidate**: a build made before a release so that it can be tested. If testing finds no problem, it becomes the release.

**Lock file**: a file, such as `package-lock.json`, that records the exact versions of the packages a project installed, so every install gives the same result.

**Hook event**: a moment when an agent calls its hooks, such as `PreToolUse` (before a tool runs), `PostToolUse` (after it ran) or `UserPromptSubmit` (when you send a prompt). The names differ a little between agents. See [Agent compatibility](compat.md#codex-cli-hook-events).

**Matcher**: the pattern in a hook setting that says which tools the hook runs for.

**Tool call**: a request from the model to use a tool, such as reading a file, running a shell command or calling an MCP server.

**Subagent**: a helper agent that another agent starts to do part of a job.

**Personal data**: details about a person, such as an email address, a phone number, an IBAN, a card number or a national ID. zn-gate can ask you before a tool call sends them.

**Protocol version**: the dated edition of the MCP standard that a client and a server agree to use, for example `2025-11-25`. See [Agent compatibility](compat.md).

**Vault audit log**: the local record of what the vault did, such as which secret was used, unlock and reset. It is the file `~/.zn/audit.jsonl` and never holds secret values. Read it with `zn vault log`. See [Secrets](secrets.md) and [Files and folders](files-and-folders.md).

**Decision log**: the local record of what zn-gate allowed or blocked. It is the file `~/.zn/evidence.jsonl`, also called the evidence log. Check it with `zn-gate evidence --verify`. See [How the log works](architecture.md).

**`zn audit`**: a command that reviews the agent configuration of a repository before you open it. It has nothing to do with the vault audit log. See [Audit](audit.md).

**Hash chain**: a way to make a log tamper-evident. Each record includes a fingerprint of the one before it, so a changed or deleted record breaks the chain. `vault verify` checks the vault audit log and `evidence --verify` checks the decision log.

**SARIF**: a standard JSON format for reports of findings, which code hosts and CI tools can show.

**OTLP** (OpenTelemetry): a standard format for sending logs to monitoring tools. `vault log export --otlp` writes the vault audit log in it.

**Sandbox**: a closed space that stops a program from touching anything outside it. zn-gate is not one: it checks what an agent's hooks can see.

**Best effort**: it works where the agent gives zn-gate enough information to act, and not everywhere. The [compatibility table](compat.md) marks these cases.

**zn Team**: the optional service for organizations. It shares a policy with every developer's machine and collects the vault audit log. See [Team](team.md).

**Join token**: the one-time code an admin gives you so that `team join` can connect your machine to your organization.

**Managed configuration** (`team managed-config`): settings files that an administrator deploys to all machines, for example with MDM (mobile device management), so the hooks run for every developer.

**Launcher script**: the small script under `~/.zn/hooks` that an agent's hook goes through. It is shared by every profile of the same agent on your machine, so `hooks uninstall` leaves it in place. See [the command list](cli.md#hooks-uninstall) and [Check that it works](check.md).

**Fail on** (`--fail-on`): the lowest severity of a finding that makes `audit` or `reach` exit with `1`. For `audit` it is `low`, `medium`, `high` (default), `critical` or `none`; for `reach` the default is `none`, so it is a report. See the [command list](cli.md).

**Evidence** (`evidence`): the local hash-chained log of what zn-gate decided. `--verify` checks the chain. See the [command list](cli.md).

**Stats**: local counts of what zn-gate did on your machine (`stats`). They are not sent unless you turn on `stats share`.

## Worked examples

These examples show terms from this page. The values are fake.

**Marker and shadow.** A `.env` file holds a secret value:

```text
STRIPE_KEY=sk_example_not_a_real_key
PORT=3000
```

In your own terminal, run:

```bash
zn env shadow .env
```

The value moves into the vault and the file keeps a marker. Your agent sees only this:

```text
STRIPE_KEY=__ZN_STRIPE_KEY__
PORT=3000
```

`zn env unshadow` restores the original from the encrypted copy. See [Secrets](secrets.md#2-move-your-env-values-into-the-vault).

**Dry run.** Add `--dry-run` to see what a command would change. For example, `zn-gate uninstall --dry-run` prints the plan (each agent, with the file paths) and changes nothing. Run the command again without `--dry-run` to do it. See the [command line reference](cli.md#uninstall).

**Exit code.** Run the check, then read the exit code:

```bash
npx -y zn-gate check
echo $?
```

The check prints one line for each agent, such as `OK Claude Code  blocked the .env file and allowed the ordinary file.` It exits with `0` only when every agent that is set up for your user is protected. See [Check that it works](check.md).

For setup steps, start with the [README](../README.md#install).
