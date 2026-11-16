# Example: a two-minute check before a demo

You are about to show your coding agent to someone, and you want to be sure
zn-gate is on and nothing leaves your machine. This page is a short checklist
of four commands, with the real output to expect. Run every command in your own
terminal, not through your agent. All values are made up. The output comes from
a test run with zn-gate 1.15.0 and Claude Code set up for the user; the home
folder is shown as `~`, and your lines for other agents will differ.

The four commands only read files, or run a test in a temporary folder. None
changes a setting and none sends anything over the network. In our test run each
one finished in under a second with zn-gate installed.

## 1. Is your agent protected?

```sh
zn-gate check
```

This is also your harmless block: zn-gate makes a temporary folder with a fake
`.env` file, asks the hook whether the agent may read it, and deletes the
folder. Expect `OK` next to the agent you will demo:

```text
  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."
```

The summary ends with `Your agent cannot read secret files such as .env through
these tools. Nothing was sent anywhere.` and the command exits with `0`.

If the line starts with `-` instead, zn is not set up for that agent. Before an
agent was set up, the same run said `zn is not set up for your agents yet, so
nothing protects your secrets` and exited with `1`. Run `zn-gate init` and check
again. [What the output means](../check.md).

## 2. Are all the hooks current?

```sh
zn-gate check --hooks
```

There is no `zn-gate hooks list` command; this is the list. It lists each
installed hook, and only reads files:

```text
zn hooks installed on this machine (nothing was run or changed):

Claude Code (user): ~/.claude/settings.json
  OK     PreToolUse [...]  '~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse
  OK     PostToolUse [...]  '~/.zn/hooks/zn-hook-claude-code.sh' PostToolUse
  OK     UserPromptSubmit  '~/.zn/hooks/zn-hook-claude-code.sh' UserPromptSubmit
  OK     UserPromptExpansion  '~/.zn/hooks/zn-hook-claude-code.sh' UserPromptExpansion
  OK     ConfigChange  '~/.zn/hooks/zn-hook-claude-code.sh' ConfigChange
  OK     InstructionsLoaded  '~/.zn/hooks/zn-hook-claude-code.sh' InstructionsLoaded

6 OK, 0 stale, 0 broken.
```

(`[...]` stands for the list of tools each hook watches, left out here.)
Expect `0 stale, 0 broken`. If a hook is stale, which means an older zn-gate
wrote it, the output gives the command that refreshes it. On a machine with no
hook, the output says `None found.` and still exits with `0`.
[What the output means](../check.md#list-every-installed-hook).

## 3. Is the cloud check off?

```sh
zn-gate status
```

```text
[+]  zn-gate Status:
  Package Version : 1.15.0
  Rules Version   : 2026-10-28.1 (scrub 2026-10-24.1, audit 2026-10-23.8)
  Active Engine   : Local rules only
  Endpoint        : None (nothing leaves this machine)
  API key         : Not set
  Leaves machine  : Nothing
```

For a demo that you want fully local, `Leaves machine : Nothing` is the line to
look for. The version and the rules version are the ones your own machine
prints. [`status` in the CLI reference](../cli.md#status).

## 4. Is the vault locked?

```sh
zn-gate vault status
```

If you do not use secrets in the demo, skip this step. On a machine with no
vault it prints:

```text
Vault: not created yet (run `npx -y zn-gate@1.15.0 unlock`).
```

If you do show secrets, the vault must be unlocked. Its other two answers start
with `Vault: unlocked (` and `Vault: locked (`, followed by the backend. A
locked vault makes `zn-gate run --secrets NAME -- <command>` stop with
`Your secret vault is locked`, so run `zn-gate unlock` before you start.
[`vault status` in the CLI reference](../cli.md#vault-status).

## Before you start

- Do not demo with a real `.env` file in the folder. Use a folder of made-up
  values, as in [the first project walkthrough](first-project-walkthrough.md).
- If a block surprises you during the demo, [Block message anatomy](block-message-anatomy.md)
  explains the message, and [`zn-gate why`](why-blocked-walkthrough.md) explains the block afterwards.

## Next steps

- For the first run on a new machine, see [First 5 minutes](../first-5-minutes.md).
- For what each line of `check` means, see [Check that it works](../check.md).
