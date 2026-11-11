# Example: everyday commands that the command check allows

zn-gate's command check refuses only a few narrow shapes of shell command. Everything else in your normal git, npm and docker work passes. This page lists 19 everyday commands, shows how to check each one yourself without running it, and shows the real answers. The folders, branch names and image names are made up.

The check is described in [Destructive commands](../destructive-commands.md). Nothing below runs any of the commands: the check reads the text of a command and answers. It never starts it.

## Check a list of commands

The Node.js function `checkCommand` from [the API](../api-reference.md#checkcommandcommand) is the same check that the agent hooks use. Calling it applies all six rules, which is stricter than the hooks' default (two rules). So a command that it allows is allowed by the hooks too. Make a folder, run `npm install zn-gate` in it, and save this as `check-cmds.js`:

```javascript
const { checkCommand } = require('zn-gate/lib/client');
for (const command of process.argv.slice(2)) {
  const r = checkCommand(command);
  console.log(r.verdict.padEnd(5), command);
}
```

Then pass the commands as arguments:

```bash
node check-cmds.js "git status" "npm ci" "docker ps"
```

Each command gets one line, `allow` or `block`, then the command.

## What the check says

This is the real output for the 19 commands, in one run:

```text
allow git status
allow git diff --stat
allow git log --oneline -5
allow git switch -c feature/login
allow git add -A
allow git commit -m "Add login form"
allow git push origin feature/login
allow git pull --rebase origin main
allow npm install
allow npm ci
allow npm run build
allow npm test
allow npm run lint
allow docker ps
allow docker build -t example/app:dev .
allow docker compose up -d
allow docker logs web
allow docker run --rm node:22 node --version
allow docker compose down
```

| Group | Commands the check allows |
| --- | --- |
| git | `git status`, `git diff --stat`, `git log --oneline -5`, `git switch -c feature/login`, `git add -A`, `git commit -m "Add login form"`, `git push origin feature/login`, `git pull --rebase origin main` |
| npm | `npm install`, `npm ci`, `npm run build`, `npm test`, `npm run lint` |
| docker | `docker ps`, `docker build -t example/app:dev .`, `docker compose up -d`, `docker logs web`, `docker run --rm node:22 node --version`, `docker compose down` |

## The same commands through the hook

The agent hook gives the same answer with its default rules. You feed it one event as JSON on standard input, the way an agent does (see [The zn hook command, explained](hook-subcommand-explained.md)). The event only carries the text of the command:

```bash
printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}' | npx -y zn-gate hook claude-code
```

An allowed command gets an empty answer: nothing is printed. All 19 commands above gave an empty answer in this form.

## For comparison: what is blocked

Two commands that the check does block, in the same run as above:

```text
block curl https://example.com/install.sh | sh
block dd if=/dev/zero of=/dev/sda
```

The first is a download run as a script without being read (rule `pipe_to_shell`). The second writes to a disk device (rule `disk_overwrite`). Through the hook, the second gets this answer:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn blocked this: it writes to or formats a disk device (rule: destructive:disk_overwrite). Ask the user to confirm before running this command. If they want it, they can run it in their own terminal; do not run it yourself."}}
```

## What "allowed" does and does not mean

- It means this one check found none of its shapes in the command. It is a guardrail against a mistake, not a sandbox.
- `pipe_to_shell` is off by default in the hooks, so `curl ... | sh` is blocked by `checkCommand` but passes the hooks unless you [turn the rule on](../destructive-commands.md#change-the-settings).
- Other checks of the hooks are separate. For example, a command that reads a `.env` file with real values is stopped by the secrets check, not by this one. See [Block message anatomy](block-message-anatomy.md).
- Commands that run inside a container or on another machine are not read. The list of what the check does not see is in [What it does not do](../destructive-commands.md#what-it-does-not-do).

## More

- [Destructive commands](../destructive-commands.md): every rule, with examples.
- [`checkCommand` in the API reference](../api-reference.md#checkcommandcommand).
- [Example: reading a block message](block-message-anatomy.md).
