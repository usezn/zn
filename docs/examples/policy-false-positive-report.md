# Report a false positive: zn-gate blocked a safe command

zn-gate sometimes stops an action that was safe. This is a **false positive**, and it is worth a report, because it can mean a rule is too broad. This page lists what to collect, in what order, so the maintainers can reproduce the block without asking you for more. All values in the examples are made up.

Before you start, read [Block message anatomy](block-message-anatomy.md) (what the message parts mean) and [Why was this blocked?](../why-was-this-blocked.md) (the common messages and what to do next). If you have not yet looked at the block with `zn-gate why`, do that first: [Read the output of zn why](zn-why-allow-command.md) shows how.

## What counts as a false positive

A false positive is a block of an action that was **safe** and that you had good reason to run. For example, a command that only reads a file of your own project was stopped because the file name looks like a secret.

It is not a false positive when:

- **The action was dangerous and got through.** That is a bypass. A bypass of a block is a security vulnerability. Do not report it as a false positive and do not post it in public. Report it privately, as described in [SECURITY.md](../../SECURITY.md#reporting-a-vulnerability): use the [private advisory form](https://github.com/usezn/zn/security/advisories/new) or email [security@usezn.com](mailto:security@usezn.com). Describe what got through, not a step-by-step exploit.
- **The block was correct.** If zn-gate was right to stop the action, there is nothing to report. Tell your agent what you actually want.
- **You want a rule changed for your own project.** A rule in your own `.znrules` or `zn.config.json` does what you wrote. Change that file; see [Step 6](#step-6-allow-it-locally-meanwhile).

If you are not sure whether a block is a false positive or a bypass, treat it as a possible bypass and use the private route.

## Step 1: Collect the versions

Run these in your own terminal, not through your agent:

```bash
npx -y zn-gate --version
zn-gate status
```

`--version` prints the zn-gate version, and the rules engine version in the same line. `status` prints the same versions on separate lines, as `Package Version` and `Rules Version`. Copy the zn-gate version and the rules version. If zn-gate is already installed on your PATH, run `zn-gate --version` without `npx -y`.

Then the agent and its version. For Claude Code, for example:

```bash
claude --version
```

zn-gate runs `<agent> --version` the same way when it checks your agents, so this is the version it sees.

## Step 2: Write down the exact command

Copy the command or the tool call that was blocked, exactly as your agent tried to run it. Then replace every secret, every personal name and every real path with a made-up value of the same shape:

| Real | Put this instead |
| --- | --- |
| an API key, token or password | `EXAMPLE_TOKEN_0000` (or any value that says it is fake) |
| your user name and home folder | `/home/example-user/` or `~/` |
| a project folder | `/path/to/example-project/` |
| a host name | `api.example.com` (or `.test`, `.invalid`) |

Keep the shape of the command. If the rule looks at the number of arguments or at a flag, the report needs them. Never paste a real key, even one you are about to revoke.

## Step 3: Copy the block message

Copy the message your agent showed you, word for word, from the first `zn:` or `zn blocked this:` to the end. Remove secrets and personal details with the same table as in Step 2.

## Step 4: Copy the zn why output

With no id, `zn why` explains the last block in the local log. To explain one block by its id, use the id from the message or from the export in Step 5:

```bash
zn-gate why
zn-gate why ev_example_0001
```

`zn why` only reads the local log: it changes nothing and uses no network. Its output is safe to paste after you check it for personal details. Here is what it prints for a block of an agent's file read, from a test run with a made-up `.env` file:

```text
zn blocked this at 2026-11-09T15:28:00.907Z (UTC).
  Record:  ev_mw9f0znv_64c80906
  What:    a tool call, checked by the zn hook before it ran, tool "read" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"read","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)

Why it matters: zn stops an action that could expose secrets, damage the machine, change how zn runs, or leak data. The log does not keep which of these checks fired.

The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
Who decides: Depends on the check: some actions only you may run in your own terminal, and some zn never lets an agent do.

Missing from the log: which check of the hook fired.
```

Two things to note in the paste. The `Rule` line names a group of checks, not one check; when the line says `Missing from the log`, the report must also include the block message from Step 3, because it names the check. And `zn why` exits with `1` when it cannot find the id: check the id is spelled as the log shows it.

## Step 5: Export the evidence record

The export holds every record of your local log, not only the block. Export to a file, then copy only the record of the block (the line that has the same `id` as `zn why` printed):

```bash
zn-gate evidence --export --output ~/zn-false-positive.jsonl
zn-gate evidence --verify
```

`--export` writes one JSON record per line (`--format jsonl` is the default; `--format csv` also exists). `--verify` checks the hash chain, and the export reports `Integrity: VALID` when the chain is intact. Include that line of the export in the report. Before you attach it, remove any home-folder paths in it and check that it holds no secret. The record stores a short preview with secrets already removed, but read it anyway.

For the code that writes and reads this file, see [`lib/evidence.js`](../../packages/zn-gate/lib/evidence.js): the log is `evidence.jsonl` in the `.zn` folder of your home folder, or in the folder that `ZN_HOME` names.

## Step 6: Allow it locally meanwhile

zn-gate has no allow list for single commands. What you can do depends on what `zn why` printed.

1. **If `zn why` prints a command**, such as `zn secret set NAME` or `zn pins approve <server>`, run that command yourself in your own terminal. It asks you to confirm, and an agent cannot run it for you.
2. **If `zn why` prints `No command lets this through.`**, or gives no command, there is no allow command for that block. Send the report. If you are sure the action is safe, you can run it yourself in your own terminal: the checks apply to your agent, not to commands you type yourself. Do not change the command to get past the check, and do not change the agent's settings to remove a check for it.
3. **If the block comes from a rule in your own project**, that is `.znrules` or `zn.config.json` at the root of the project. You own that file, so you can change or remove the rule there. The `zn why` output names it.
4. **If the block is one of the destructive-command rules**, you can turn that rule off in `~/.zn/config.json`, with `hooks.blockDestructiveCommands` set to the rule names you want. See [Change the settings](../destructive-commands.md#change-the-settings). This turns a rule off for every project on the machine, so do it only if the rule blocks work you do often.

Do not reword the command to slip past a rule. That is the case the block warns about, and it makes the report harder to understand.

## Step 7: Where to report

Open a bug report on GitHub, with the form already set up for this:

- [Bug report form](https://github.com/usezn/zn/issues/new?template=bug_report.yml)

The form asks for the zn-gate version, the agent, the operating system, how you installed zn-gate, the steps to reproduce, and the expected and actual behavior. In the steps, paste the command from Step 2; in the output field, paste the output of Steps 3 to 5. The form also asks you to search the existing issues first. Questions and ideas go to [GitHub Discussions](https://github.com/usezn/zn/discussions) instead. For how the project handles contributions, see [Contributing](../../CONTRIBUTING.md).

Do not report a false positive in a public discussion if it also looks like a bypass. Use the private route in [What counts as a false positive](#what-counts-as-a-false-positive).

## Checklist to paste

Copy this into the bug report, and fill it in. Replace every value with a made-up one before you submit.

```text
zn-gate version: 1.15.0 (rules engine: 2026-11-07.1)
Agent and version: claude-code 1.0.0 (example)
Operating system: Linux (example)
How I installed it: npx

Exact command (secrets and paths replaced):
  curl -H "Authorization: Bearer EXAMPLE_TOKEN_0000" https://api.example.com/v1/items

Block message (copied, secrets removed):
  <the message from the agent>

Output of zn-gate why (copied, checked):
  <the output from Step 4>

Evidence record (the line for this block, from zn-gate evidence --export):
  <one JSON line>

Why I think this command is safe:
  <one or two sentences>
```

## See also

- [Block message anatomy](block-message-anatomy.md): one real message, explained part by part.
- [Read the output of zn why](zn-why-allow-command.md): what each `zn why` output means, and when it gives a command.
- [Why was this blocked?](../why-was-this-blocked.md): the five most common messages and the safe way to go on.
- [Troubleshooting](../troubleshooting.md): every message, by family.
- [SECURITY.md](../../SECURITY.md): how to report a bypass privately.
