# Example: everyday commands zn-gate allows and blocks

Twenty decisions the zn-gate hook made on ordinary agent actions, so you know what to expect in a normal day: most things go through, a few stop. Every decision below was made by the real hook with the default settings, in a throwaway home folder with a made-up project. The hook only reads the text of the action, so nothing was run. All names and values are made up.

For the rules behind the blocks, see [Destructive commands](../destructive-commands.md). For every reason text, see [Block and warn reasons, by family](../troubleshooting.md#block-and-warn-reasons-by-family).

## How the decisions were made

The hook for Claude Code reads one event on standard input and answers on standard output ([`hook` in the command line reference](../cli.md#hook)). For each action, this was run in the throwaway project:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}' | zn hook claude-code
```

An allowed action prints nothing. A stopped one prints a `permissionDecision` of `deny` (it does not run) or `ask` (your agent asks you first), with the reason that your agent shows. The hints in the reasons name `npx -y zn-gate@1.15.0 ...` because `zn` was not on the PATH in that run; this page shows `zn` instead.

## Allowed

These all went through with no output.

| Action | Why it passes |
| --- | --- |
| `ls -la` | A plain listing. |
| `git status` | Nothing sensitive in it. |
| `git push --force origin main` | The hook does not read git history rewrites. Protect branches on the server. |
| `npm install` | Nothing in the command is sensitive. To look at a package before you install it, see [Package install check](../package-install-check.md). |
| `python3 -m pytest -q` | An ordinary test run. |
| `rm -rf node_modules` | A recursive delete of a folder in your project is not a delete of the home folder, the root or a system folder. |
| `cat package.json` | An ordinary project file. |
| Read `src/app.js` | An ordinary source file. |
| `curl https://example.com/install.sh \| sh` | The `pipe_to_shell` rule is **off by default**. |
| `chmod -R 777 /` | The `perm_root` rule is **off by default**. |

The last two surprise people. Two rules are on by default (`rm_root_home` and `disk_overwrite`) and four are off until you turn them on. [Change the settings](../destructive-commands.md#change-the-settings) shows how. Because the hook is a guardrail and not a sandbox, run untrusted code in a container or a virtual machine.

## Stopped

| Action | Decision | What the reason says (start of the text) |
| --- | --- | --- |
| `rm -rf ~` | deny | `zn blocked this: it deletes the home folder, the filesystem root or a system folder, recursively. Ask the user to confirm before running this command.` |
| `rm -rf /` | deny | The same reason. |
| `rm -rf /usr` | deny | The same reason: `/usr` is a top-level system folder. |
| `dd if=/dev/zero of=/dev/sda` | deny | `zn blocked this: it writes to or formats a disk device. Ask the user to confirm before running this command.` |
| `cat ~/.ssh/id_rsa` | deny | `zn: ~/.ssh/id_rsa was not read because zn treats it as holding secrets (SSH private key), and secret values never go to the model.` |
| `cat ~/.aws/credentials` | deny | The same text, naming `~/.aws/credentials` (AWS credentials file). |
| `cat .env` | deny | `zn: .env holds plain-text secrets. Ask the user to run zn env shadow .env in their terminal` |
| Read `.env` | deny | The same reason as `cat .env`: the file tools are checked too. |
| `cat ~/.zn/config.json` | deny | `zn blocked this: ~/.zn ... is where zn keeps your secrets, so agents may not read or change it.` |
| Write `AGENTS.md` | ask | `zn: this writes to AGENTS.md, which your agent reads as standing instructions in later sessions. Approve only if you asked for this change.` |

The last row is not a block: your agent asks you, and you answer. `echo "x" >> AGENTS.md` got the same `ask`. In strict mode (`ZN_STRICT=1`) it is a block instead, as described in [Troubleshooting](../troubleshooting.md).

## Reading the pattern

- **zn stops what cannot be undone or what exposes a secret**: wiping the home folder or a disk, and reading a file that holds credentials.
- **zn lets ordinary project work through**: listing, testing, installing and deleting inside the project.
- **A block is a message to the agent, not a dead end.** For each one of these, the reason names the next step. If you meant the command, run it yourself in a terminal; the check applies to agents only. To see the explanation again, run [`zn why`](zn-why-allow-command.md).

For one real block message taken apart, see [Block message anatomy](block-message-anatomy.md). For a first block and what to decide, see [Why was this blocked?](../why-was-this-blocked.md).
