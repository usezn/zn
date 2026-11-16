# Examples: shell aliases and functions that hide the zn command

A worked example of two questions that look alike. Which `zn` does your own terminal run when you type it? And what does the zn hook see when your agent runs a command? An alias or a function in your shell can change the first answer. It does not change the second. All names, paths and values below are made up. The outputs come from real runs of zn-gate on a test machine; the path and the version on your computer can be different.

Back to the [examples index](README.md).

## Which `zn` runs in your terminal

`zn` and `zn-gate` are two names for the same program. If you defined an alias or a function called `zn` (for example in `~/.bashrc` or `~/.zshrc`), your shell runs that instead of the program, and every command in the zn docs does something else.

To see what the name means in your shell, run:

```bash
type zn
```

On a normal install the answer is the path of the program:

```text
zn is /usr/local/bin/zn
```

With an alias in the way, it says so:

```text
zn is aliased to `echo this-is-not-zn'
```

With a function in the way:

```text
zn is a function
zn ()
{
    echo this-is-a-function
}
```

`type -a zn` lists every meaning of the name, the alias first and the program after it:

```bash
type -a zn
```

```text
zn is aliased to `echo this-is-not-zn'
zn is /usr/local/bin/zn
```

The `type` command is a feature of bash and zsh, and the outputs above are from bash.

## Get past the alias for one command

With the alias in place, `zn version` prints the alias text instead of the version:

```text
this-is-not-zn version
```

Each of these runs the program itself:

```bash
command zn version
\zn version
zn-gate version
```

```text
zn-gate 1.15.0 (rules engine: 2026-11-08.11; scrub rules: 2026-10-31.1; audit rules: 2026-11-06.4)
```

`command zn` and `\zn` skip aliases and functions for that one call. `zn-gate` is the same program under its other name, so an alias on `zn` does not touch it. To remove the alias or the function for the rest of the session, run `unalias zn` or `unset -f zn`; to remove it for good, delete the line from your shell startup file.

## The hooks do not use your `zn`

The settings that `zn hooks install` writes for your agent do not call `zn` by name. They call a small launcher script by its full path, and the launcher holds the full path of the Node.js and of the zn-gate that installed it. This is one entry of the Claude Code settings after an install in a test home folder:

```json
"hooks": [
  {
    "type": "command",
    "command": "'<home>/.zn/hooks/zn-hook-claude-code.sh' PreToolUse",
    "timeout": 15,
    "onFailure": "block"
  }
]
```

So an alias or a function named `zn` does not switch the hooks off, and it does not change what they decide. To check that the hooks are installed and healthy, run the check from your own terminal, using the program itself:

```bash
zn-gate check --hooks
```

See [Check that it works](../check.md#list-every-installed-hook) for what the lines mean.

## What the hook sees: the text of the call

When your agent runs a shell command, the hook gets the text of that command as a JSON event and decides from that text. It does not run the command and it does not ask your shell what a name means, so it never expands an alias or a function.

These are real answers of the Claude Code hook for six tool calls. The test folder held a `.env` file with a made-up value. Nothing was run: the hook only reads the event.

| Text of the call | Hook answer |
| --- | --- |
| `cat .env` | Denied: `.env` holds plain-text secrets |
| `alias show=cat; show .env` | Denied: the same reason |
| `c() { cat "$@"; }; c .env` | Denied: the same reason |
| `ls -la` | Allowed |
| `alias ll='ls -la'` | Allowed |
| `zn secret set EXAMPLE_API_KEY` | Denied: a zn command that only you may run, with the step to run in your own terminal |

The first three rows are denied because of the file name in the text, not because the hook knew that `show` or `c` meant `cat`. A file the hook protects stays protected under any name for the reader program, as long as the file itself is named in the call.

The other direction has a limit. A name that exists only in your shell, such as a function `z` that calls `zn`, means nothing to the hook:

```text
z() { zn "$@"; }; z secret set EXAMPLE_API_KEY
```

The hook finds no zn command and no protected file in this text, so it has no zn-specific reason to deny it, and it allowed the call in the test. Two things keep this from being a way around zn. The commands that only a person may run refuse to work without a terminal; run without one, `zn secret set` stops with `Not allowed: zn secret set needs an interactive terminal. Open a terminal window yourself and run it there.` And the protected files stay protected, whatever name your function has.

## What to do

- If a zn command in the docs does not do what the docs say, run `type zn` first.
- Keep functions and aliases that wrap `zn` out of the shell your agent uses. The hook cannot tell what a name of your own means, so a wrapper hides a command from the hook and from you.
- Use `zn-gate` or `npx -y zn-gate` in scripts. They do not depend on what you defined in your shell.

## See also

- [The zn hook command, explained](hook-subcommand-explained.md): who calls the hook and what one call looks like.
- [Block message anatomy](block-message-anatomy.md): how to read what the agent is told.
- [Threat model: what zn does not protect against](../threat-model.md#what-zn-does-not-protect-against): what the hooks can and cannot see.
