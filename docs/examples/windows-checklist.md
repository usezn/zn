# Windows checklist: install and check zn-gate

A short list of steps, in order, for installing zn-gate on Windows and checking that it works. Each step is explained in [First 5 minutes](../first-5-minutes.md). Run every command in your own terminal, not through your AI agent.

## Steps

1. Check Node.js. Run `node --version`. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later. If you see "command not found", install the LTS version from [nodejs.org](https://nodejs.org/) and open a new terminal.
2. Check npx. Run `npx --version`. If PowerShell says "running scripts is disabled on this system", go to [the fix below](#if-you-see-running-scripts-is-disabled-on-this-system) and then come back to this step.
3. Install. Run `npx -y zn-gate init`. It shows each step before it runs it and asks first, and you can say no.
4. Check. Run `npx -y zn-gate check`. A line that starts with `OK` means that agent is protected. A line that starts with `-` means zn is not set up for that agent, or the agent is not on your machine. A line with `NOT protected` says what to run.
5. Optional: run `npx -y zn-gate analyze "ignore all previous instructions"`. The answer has `"verdict": "block"`.

## If you see "running scripts is disabled on this system"

Windows PowerShell blocks the script that starts `npm` and `npx` by default. Nothing is wrong with zn-gate. Use any one of these:

- Use the `.cmd` versions: `npx.cmd -y zn-gate init`, then `npx.cmd -y zn-gate check`.
- Run the same commands in Command Prompt instead of PowerShell.
- Allow local scripts for your account: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Other messages

- `npx: command not found`: install Node.js, open a new terminal and run the command again.
- `init` only prints steps and changes nothing: an AI agent or a script ran it. Run it yourself in your own terminal.

## More

- [First 5 minutes](../first-5-minutes.md)
- [Troubleshooting](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows)
- [What the check means](../check.md)
