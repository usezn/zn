
# Example: what to do when zn-gate blocks a command

The first block is often a surprise: an agent of yours tried to run a command,
zn-gate stopped it, and you have to decide what happens next. This page is a
short checklist for that moment. The full behaviour is on
[Destructive commands](../destructive-commands.md), every command on the
[command line reference](../cli.md).

## What a block means

When a command is blocked, it does not run, and the agent is told why and to
ask you to confirm before it runs the command. A block tells you two things:
the command did not run, and which rule matched. The rule name appears with a
`destructive:` prefix, for example `destructive:rm_root_home` for
a recursive delete of the home folder.

Two rules are on by default in the agent hooks: `rm_root_home` (a
recursive delete of the home folder, the filesystem root or a system folder)
and `disk_overwrite` (a write to a disk device). Four more rules
(`pipe_to_shell`, `rc_download`, `perm_root`,
`fork_bomb`) are off unless you turn them on.

## Ask why, in your own terminal

```sh
zn-gate why
```

With no id, `zn-gate why` explains the last block in plain words: what
was stopped, which rule fired, why that matters, and the one command you can
run in your own terminal to go on, when such a command exists. It only reads
the local evidence log: it changes nothing and uses no network. To see the
log itself:

```sh
zn-gate evidence
```

`zn-gate evidence` prints the counts and the last records. With
`--export` it writes the records out; the `id` field of a record
is what `zn-gate why <id>` takes.

## The decision, in three questions

1. **Was the command a mistake?** Tell the agent what you actually want.
   There is nothing to change: the block did its job.
2. **Was the command what you meant?** Run it yourself in a terminal. The
   check applies to agents only.
3. **Does a rule block work you do often?** Change the settings instead of
   repeating the same detour: `hooks.blockDestructiveCommands` in
   `~/.zn/config.json`, as described on
   [Change the settings](../destructive-commands.md#change-the-settings).

| Setting | Rules applied |
| --- | --- |
| not set | `rm_root_home` and `disk_overwrite` (the default) |
| `true` | all six rules |
| `false` | none: the check is off |
| a list of rule names | exactly those rules |

The environment variable `ZN_BLOCK_DESTRUCTIVE=1` turns on all six
rules. The environment can only add protection, never remove it: turning
rules off is only possible from the config file, which the file tools of an
agent cannot write (they cannot write to `~/.zn`).

## Two limits to keep in mind

The check is a guardrail against a mistake of the model or a bad suggestion,
not a sandbox. Untrusted code should run in a sandbox, such as a container or
a virtual machine, not on your own machine. And the check reads command text
only: for the shapes it does not cover, see [What it does not do](../destructive-commands.md#what-it-does-not-do).

## More

- [Why was this blocked?](../why-was-this-blocked.md)
- [Destructive commands](../destructive-commands.md)
