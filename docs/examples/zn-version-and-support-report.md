# Example: what to include in a bug report

When something does not work, a report that names your zn-gate version, your operating system and your agent can be answered much faster. This page shows the commands that give you those facts, with their real output, and what to remove before you paste. The output was captured from the real commands on a throwaway Linux machine with Codex CLI set up and no cloud key; the folder names are shortened to `~`. Your numbers and paths will differ. Run the commands yourself, in your own terminal.

All of them only read: nothing is changed, and nothing is sent anywhere.

## 1. The version

```bash
zn version
```

```text
zn-gate 1.15.0 (rules engine: 2026-11-04.35; scrub rules: 2026-10-31.1; audit rules: 2026-11-06.3)
```

Exit code `0`. `zn --version` prints the same. If `zn` is not installed on your computer, use `npx -y zn-gate --version`. See [`version`](../cli.md#version) in the command reference.

## 2. The status

```bash
zn status
```

```text
[+]  zn-gate Status:
  Package Version : 1.15.0
  Rules Version   : 2026-11-04.35 (scrub 2026-10-31.1, audit 2026-11-06.3)
  Active Engine   : Local rules only
  Endpoint        : None (nothing leaves this machine)
  API key         : Not set
  Leaves machine  : Nothing
```

This says whether the optional [cloud check](../connect.md) is on. It never prints the key. If you connected, one extra line ends with the last four characters of the key: remove that line from a report. See [`status`](../cli.md#status).

## 3. The check

```bash
zn check
```

This is the output that helps most: for each agent it says whether zn is set up and whether it blocked a fake `.env` file in a temporary folder. The end of the output of the throwaway machine, with Codex CLI set up:

```text
  OK Codex CLI    blocked the .env file and allowed the ordinary file. Your agent would be told:
     ...
     version: not found (tested with 0.163.0)

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
Not set up yet: Claude Code. To add it, run `npx -y zn-gate init` in your own terminal: it shows each step and asks before it runs one.

The test folder was deleted.

Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.
Hooks: 7 OK, 0 stale, 0 broken. Run zn-gate check --hooks for details.
```

The lines for agents that are not on the machine and the "Your agent would be told" text are left out here. The hint lines may print `npx -y zn-gate@1.15.0 ...` when `zn` is not on your PATH; the page shows `zn`. A line that starts with `X` and says `NOT protected` is the one to include. How to read it: [what `zn check` shows](../check.md) and [check output explained](check-output-explained.md).

## 4. The hooks, if the problem is about one agent

```bash
zn check --hooks
```

```text
zn hooks installed on this machine (nothing was run or changed):

Codex CLI (user): ~/.codex/hooks.json
  OK     PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  ...

7 OK, 0 stale, 0 broken.
```

Each line is `OK`, `STALE` or `BROKEN`. The file and launcher paths contain your user name: replace it, as in the next section. The command is `check --hooks`; there is no `hooks status` command.

## 5. What to remove before you paste

- **Your user name and folders.** Paths such as `/home/<you>/...` or `C:\Users\<you>\...` name you. Replace the user name, for example with `~`.
- **Any key or token**, including the last four characters of an API key from `zn status`.
- **Names of private projects** you do not want to share.

What never goes into a report:

- The content of a `.env` file, a vault file or a key, in any form. Never paste a key; the bug form says the same.
- A whole log. Paste the few lines about the problem.
- Anything that contains a secret value. If a block message shows a marker such as `__ZN_<NAME>__`, the marker is safe to share; the value behind it is not.

A security problem is not a bug report: do not post it as an issue. Follow the [security policy](https://github.com/usezn/zn/security/policy).

## 6. Where to send it

- A bug that you can reproduce: [GitHub issues](https://github.com/usezn/zn/issues). The form asks for the same facts as this page: the version, your agent, your operating system and how you installed zn-gate, plus the steps, the output and what you expected.
- A question: [Discussions](https://github.com/usezn/zn/discussions). Say your version, your operating system and the message.
- A message you do not understand: look it up in [troubleshooting](../troubleshooting.md) first.

To put the operating system in the report, say "macOS", "Linux" or "Windows" and, if you know it, the version.

## More

- [`version`, `status` and `check` in the command reference](../cli.md#status)
- [Troubleshooting](../troubleshooting.md)
- [Which command shows what](which-command-shows-what.md)
