# Example: reading a block inside a wrapped command

Agents often run a command through a wrapper: `bash -c "..."`, `sh -c "..."`,
`sudo`, `env`. zn-gate reads through these wrappers, so the command inside is
judged as if it stood alone. This page shows what that looks like, with the
real verdicts and the real denial text, and what is not seen. Nothing here
runs a command: the checks read text only. All values are made up. For the
rules themselves, see [Destructive commands](../destructive-commands.md).

## The same block, plain and wrapped

Use `checkCommand` from the [Node.js API](../api-reference.md#checkcommandcommand).
It always applies all six rules and returns a verdict:

```javascript
const { checkCommand } = require('zn-gate/lib/client');

checkCommand('rm -rf ~');
checkCommand('sudo bash -c "rm -rf /tmp/example"');
```

Both return a block with the same rule (the `rules_version` is the version of
the rule set you run):

```json
{"verdict":"block","confidence":0.95,"rule":"destructive:rm_root_home","reason":"Destructive command: it deletes the home folder, the filesystem root or a system folder, recursively","engine":"oss-local","rules_version":"2026-11-09.2"}
```

These wrapped forms are blocked with the same rule, `destructive:rm_root_home`:

| Command | Verdict |
|---|---|
| `bash -c "rm -rf ~"` | block |
| `bash -lc "rm -rf ~"` | block |
| `sh -c 'rm -rf $HOME/*'` | block |
| `sudo rm -rf /usr` | block |
| `sudo -u root rm -rf /usr` | block |
| `env FOO=1 rm -rf /tmp/example` | block |
| `sudo bash -c 'rm -rf /tmp/example'` | block |
| `env -i sudo sh -c "rm -rf /"` | block |
| `nohup rm -rf ~` | block |
| `timeout 5 rm -rf ~` | block |

A wrapper does not make a harmless command look dangerous. These are allowed
(`verdict` is `allow`, `rule` is `none`):

| Command | Why it passes |
|---|---|
| `bash -c "rm -rf ./build"` | The target is a project folder, not the home folder or a system folder |
| `sudo rm -rf ./build` | Same target |
| `echo "rm -rf ~"` | The text is only printed |
| `bash -c "echo rm -rf ~"` | The text is only printed, inside the wrapper too |

## How deep it reads

The code of `sh -c` and `bash -c` is read again, up to three levels deep. We
wrapped the same block in more and more shells:

```text
bash -c "rm -rf ~"                                => block  destructive:rm_root_home
bash -c "sh -c 'rm -rf ~'"                        => block  destructive:rm_root_home
bash -c "sh -c \"bash -c 'rm -rf ~'\""            => block  destructive:rm_root_home
bash -c "sh -c \"bash -c \\\"sh -c 'rm -rf ~'\\\"\"" => allow  none
```

A block four shells deep is not read. The limit is `MAX_DEPTH = 3` in
`packages/zn-gate/lib/destructive.js`, and the page on destructive commands
states the same limit.

## What it does not see

- A target that arrives through a pipe or a file. `echo ~ | xargs rm -rf` and
  `xargs rm -rf < list.txt` are both allowed, because the command text holds
  no path. The same is true of a script that is saved first and run later:
  `bash script.sh` is allowed, since the check does not read the file.
- A wrapper that changes the folder first. `sudo bash -c "cd ~ && rm -rf ."`
  is allowed, because the check does not follow where the command runs.

The [list of what the check does not do](../destructive-commands.md#what-it-does-not-do)
has the rest. For these, use a sandbox, a container or your agent's own
permission prompts.

## What the agent sees

An agent does not call `checkCommand`. Its hook does. For Claude Code, the hook
reads one event as JSON on standard input ([the hook command, explained](hook-subcommand-explained.md)
shows the shape). Here is a wrapped command, in a throwaway home folder:

```json
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sudo bash -c \"rm -rf /tmp/example\""}}
```

```sh
zn-gate hook claude-code
```

The answer on standard output, from a real run (the command itself exits with
`0`; the deny is in the JSON):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn blocked this: it deletes the home folder, the filesystem root or a system folder, recursively (rule: destructive:rm_root_home). Ask the user to confirm before running this command. If they want it, they can run it in their own terminal; do not run it yourself."}}
```

`env DEBUG=1 sh -c "rm -rf ~"` gets the same answer. An allowed command, such as
`bash -c "rm -rf ./build"`, gets an empty answer.

The hook applies only two rules by default: `rm_root_home` and `disk_overwrite`.
A wrapped download piped to a shell, `bash -c "curl https://example.com/install.sh | sh"`,
is blocked by `checkCommand` (rule `destructive:pipe_to_shell`) but passes the
hook until you turn that rule on.

## After a block: `zn why` and the allow path

`zn-gate why` explains the last block from the local log. For a hook block it
does not name the rule. This is the real output after the block above:

```text
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)
  ...
The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
```

So the rule name to read is the one in the message the agent showed you:
`(rule: destructive:rm_root_home)`.

There is no `zn why` command that lets one blocked command through. Your two
choices:

1. If you really want the command, run it yourself, in your own terminal. That
   is what the message tells the agent to ask you.
2. If a rule gets in the way of your work, change the rules in
   `~/.zn/config.json`. Only you can do this: the agent's file tools cannot
   write there. In our test, `{"hooks": {"blockDestructiveCommands": ["pipe_to_shell"]}}`
   let the `rm` command through and blocked the download, and
   `{"hooks": {"blockDestructiveCommands": false}}` let the `rm` command
   through. Turning the check off removes protection for every command, not for one.
   [Destructive commands](../destructive-commands.md#change-the-settings) lists the settings.

## Next steps

- Read [the anatomy of a block message](block-message-anatomy.md) for the parts of a message.
- Read [allow a blocked action after zn why](zn-why-allow-command.md) for the blocks that do have a command.
- For every rule and what it misses, read [Destructive commands](../destructive-commands.md).
