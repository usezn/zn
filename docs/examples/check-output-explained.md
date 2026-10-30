# Example: reading a check output line by line

A walk through a sample `npx -y zn-gate check` output. The explanations come from the [full page](../check.md), which also lists every reason a line can give and how to repair it. The output below is a sample: your agents and lines will differ.

```text
zn-gate check: does zn stop your coding agent from reading a secret?

  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: ..."
  -  Codex CLI    zn is not set up for this agent. To protect it, run `zn hooks install codex` in your own terminal.
  -  Cursor       not found on this machine

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
```

## The first line

`zn-gate check: does zn stop your coding agent from reading a secret?` is the title. The check makes a temporary folder with a `.env` file that holds a fake key and an ordinary `README.txt`. For each agent set up for your user, it asks zn's hook to let the agent read each file, the same way your agent asks. Nothing is sent over the network, no agent is started and no setting changes. The folder is deleted at the end.

## The `OK` line

`OK Claude Code  blocked the .env file and allowed the ordinary file.`

`OK` means zn is protecting that agent. An agent counts as protected only when the `.env` file is blocked and the ordinary file is allowed. The line `"zn: ..."` under it is the text your agent is told when it tries to read the file.

## The `-` lines

`-  Codex CLI    zn is not set up for this agent. ...`

`-` means zn is not set up for that agent, neither for your user nor in managed configuration, or only for one project. The line gives the command that sets it up for your user. If you only ran zn-gate with `npx`, that command starts with `npm install -g zn-gate`, because `zn hooks install` needs zn-gate installed for your user. Because an agent was found but not set up, the summary can also point to `npx -y zn-gate init`, which shows each step and asks before it runs one.

`-  Cursor       not found on this machine`

An agent that is not on this machine is listed as *not found on this machine*. There is nothing to do for it.

## The last line

`Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.` is the summary, and `Nothing was sent anywhere` repeats that the check makes no network calls.

## A line that would start with `X`

This sample has none. A line that starts with `X` and says **NOT protected** means zn is set up but would not protect the agent. It gives one reason and one repair. Run the repair in your own terminal, then run `npx -y zn-gate check` again. Every reason is explained in [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## The exit code

`zn-gate check` exits with 0 only when every agent that is set up for your user is protected.

## More

- [Check that it works](../check.md): the full page.
- [First project walkthrough](first-project-walkthrough.md)
