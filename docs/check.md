# Check that it works

After you install zn-gate for your coding agent, run:

```bash
npx -y zn-gate check
```

(or `zn-gate check` if you installed it with `npm i -g zn-gate`).

## What it does

zn-gate makes a temporary folder with two files: a `.env` file that holds a fake key (`ZN_CHECK_EXAMPLE_KEY=zn-check-fake-value-not-a-real-key`) and an ordinary `README.txt`. For each agent set up for your user, it asks zn's hook to let the agent read each file, the same way your agent asks. An agent counts as protected only when the `.env` file is blocked and the ordinary file is allowed.

- **Claude Code**: zn-gate checks the zn-gate plugin, or the hooks of `zn hooks install claude-code`. It also notices when the plugin is turned off and when a Claude Code setting turns hooks off. If your hooks were installed by an older zn-gate and lack the check for typed skills and commands, it suggests running `zn hooks install claude-code` again.
- **Codex CLI and Cursor**: zn-gate checks the hooks of `zn hooks install`. A zn-gate plugin for Cursor is reported as **NOT protected** and is never run (see [Cursor plugin](#cursor-plugin)).
- **What it runs**: for Claude Code, Codex CLI and Cursor it runs the hook that is installed, exactly as your agent would. For the Claude Code plugin, that is the PreToolUse command of the plugin's `hooks/hooks.json`, run the way Claude Code runs it (see [Claude Code plugin](#claude-code-plugin)). On Windows, a hook installed as `zn hook <agent>` is not started; zn-gate checks zn's rules for it instead and says so in the output. A hook that cannot start, or that blocks every file because part of zn is missing, is reported as **NOT protected**.
- **OpenCode**: zn-gate checks zn's rules. The zn plugin runs inside OpenCode, so it is not started here.
- **Managed setups**: when your organization deploys zn through managed configuration (Claude Code managed settings, Cursor's enterprise `hooks.json`, Codex's `requirements.toml`), `zn-gate check` counts the agent as set up and names the file ("zn is installed through your organization's managed configuration"). `zn-gate status` lists it too. If zn is also set up for your user, both run, and the check says so. Policy sent only through MDM profiles, the Windows registry or an agent's cloud is not seen. If the managed hooks are broken, the line ends with: ask your administrator to repair the managed configuration (<file>). Nothing is written.
- **What it leaves alone**: it checks the setup for your user and the managed configuration files above. A setup made for one project only (`--project`) is listed but not run.
- **Nothing changes**: nothing is sent over the network, no agent is started and no setting changes. The folder is deleted at the end.

## What you will see

```text
zn-gate check: does zn stop your coding agent from reading a secret?

  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: ..."
  -  Codex CLI    zn is not set up for this agent. To protect it, run `zn hooks install codex` in your own terminal.
  -  Cursor       not found on this machine
  ...

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
```

- **OK**: zn is protecting that agent. The quoted text is what your agent is told when it tries to read the file.
- **-**: zn is not set up for that agent (neither for your user nor in managed configuration), or only for one project. The line gives the command that sets it up for your user. If you only ran zn-gate with `npx`, that command starts with `npm install -g zn-gate`, because `zn hooks install` needs zn-gate installed for your user. An agent that is not on this machine is listed as *not found on this machine*.
- When an agent is found but not set up, the summary points to `npx -y zn-gate init`, which shows each step and asks before it runs one.
- **X ... NOT protected**: zn is set up but would not protect the agent. The line says why and what to run to fix it. Every reason is explained in [What each NOT protected line means](#what-each-not-protected-line-means). When a hook cannot start because the Node.js it was installed with is gone (for example after `nvm uninstall`), the fix is a fresh `npm install -g zn-gate` and then `zn hooks install <agent>`, since the old Node.js took its `zn` with it.

`zn-gate check` exits with 0 only when every agent that is set up for your user is protected.

## What each NOT protected line means

A line that starts with `X` and says **NOT protected** gives one reason and one repair. Parts in angle brackets, such as `<file>`, are blanks that zn-gate fills in. Run every repair in your own terminal, then run `npx -y zn-gate check` again. Each reason below is quoted as zn-gate prints it.

### The hooks are set up but cannot run

- **The read check is missing.**

  ```text
  zn's hooks are there, but not the one that checks reading files (<event>)
  ```

  zn's hooks are installed for that agent, but the one that runs before a file is read is not among them. Run `zn hooks install <agent>` again.

- **The Node.js or the zn-gate files the hook uses are gone.**

  ```text
  its hook cannot start: its Node.js (<path>) is no longer there
  its hook cannot start: its zn-gate files (<path>) is no longer there
  its hook cannot start: its Node.js (<path>) is no longer there, so zn now blocks the tool calls and prompts instead of checking them
  ```

  The last form is a Codex CLI or Claude Code hook that goes through zn's launcher script, which blocks the agent's tool calls and prompts (instead of letting them run unchecked) when the Node.js it was installed with is gone and no `zn` can be found on your PATH. Until you repair it, the agent cannot run commands. If `zn` and `node` are on your PATH the hook keeps working and `zn-gate check` only notes that the Node.js it was installed with is gone.

  This usually happens after you removed or upgraded Node.js with a version manager such as nvm: the old Node.js took its copy of zn-gate with it. The repair is:

  ```text
  install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install <agent>`, in your own terminal
  ```

- **A project hook is a bare `zn hook`.**

  ```text
  the hook in <file> is a bare `zn hook <agent>`, so where zn or Node.js cannot start, <Agent> runs the call unchecked
  ```

  The hooks file of the project you are in (written by an older zn-gate, or by hand) runs `zn hook <agent>` with no start guard. Where `zn` or Node.js cannot start, the command fails with exit code 127 and the agent runs the call with no check. Run `zn hooks install <agent> --project` again in that project: it writes the same command inside a guard that blocks instead. When the agent is set up for your user, this shows as a note under **OK**; when it is not, the line is **NOT protected**.

- **A project hook was modified.**

  ```text
  the zn hook in <file> was modified (it is not the guard zn writes); run `zn hooks install <agent> --project` again in that project
  ```

  The hook in the project file looks like zn's start guard but is not exactly the command zn writes (someone edited it). `zn-gate check` never runs a project file, so it cannot tell what the edit does. Run `zn hooks install <agent> --project` again: it replaces the command with the exact guard. It is a note under **OK** when the agent is set up for your user, and **NOT protected** otherwise.

- **A plugin starts its hook with a program by name (ZCode, Claude Code).**

  ```text
  the zn-gate plugin starts its PreToolUse hook with `sh` by name, so a program or script in a relative or empty PATH entry, or in the folder the agent runs in, could run in its place and skip zn
  update the plugin: run `claude plugin update zn-gate@usezn` in your own terminal; if `zn-gate check` still reports this, use zn's hooks instead: run `npm install -g zn-gate`, then `zn hooks install claude-code`, then `claude plugin disable zn-gate@usezn`, all in your own terminal, then run `zn-gate check` again
  update the plugin: install the zn-gate plugin again in ZCode (Settings, Plugins), then run `zn-gate check` again
  ```

  The agent looks a bare program name up on its own PATH before zn's hook runs, so zn cannot clean that lookup. `zn-gate check` reads the plugin's `hooks/hooks.json` and accepts only the form zn's plugins use: a system shell by its full path (`/bin/sh`, `/bin/bash`, `/bin/dash` or the same under `/usr/bin`), with no option, nothing in front and no `*`, `?` or `[`, running a script that is a file inside the plugin folder (links are followed, so a link out of the folder does not count). Anything else is reported, and the hook is not run: a program by name, `env` or another program that starts the next one, code given inline (`sh -c`, `node -e`), a script outside the plugin folder or a relative one, a `NAME=value` in front, or a shell command line with `;`, `&`, `|`, `<`, `>` or a command substitution. On Windows, a Claude Code hook must also say `"shell": "bash"`. For ZCode, install the plugin again (Settings, Plugins). For Claude Code, update the plugin with `claude plugin update zn-gate@usezn` (since zn-gate 1.14.0 it starts its hooks with `/bin/sh`), or use zn's hooks.

- **The ZCode plugin's hook program is not on this computer.**

  ```text
  the zn-gate plugin starts its hook with /bin/sh, which is not on this computer, so the hook cannot start
  the ZCode plugin needs a system with /bin/sh (Linux); elsewhere use `zn hooks install zcode` in your own terminal, then run `zn-gate check` again
  ```

  The ZCode plugin starts its hooks with `/bin/sh`, so it works on Linux. On other systems, use `zn hooks install zcode` instead.

- **The ZCode plugin has no PreToolUse hook.**

  ```text
  the zn-gate plugin has no PreToolUse hook in <plugin folder>/hooks/hooks.json, so ZCode runs no zn check before tool calls
  the PreToolUse hook of the zn-gate plugin in <plugin folder>/hooks/hooks.json is not the hook the plugin ships (`/bin/sh ${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh PreToolUse`, turned on, for every tool), so ZCode runs no zn check before tool calls
  install the zn-gate plugin again in ZCode (Settings, Plugins), then run `zn-gate check` again
  ```

  The plugin's hooks file is missing, unreadable or was edited. Installing the plugin again restores it.

- **The hook script of a plugin is not one zn-gate ships.**

  ```text
  the hook script of the zn-gate plugin (<plugin folder>/scripts/zn-node.sh) is not one zn-gate ships (sha256 <first 12 characters>), so nothing shows that it runs zn's checks
  install the zn-gate plugin again ...
  the hook script of the zn-gate plugin (...) is not one zn-gate ships (...), so nothing shows that it runs zn's checks; the plugin (<plugin version>) is newer than this zn-gate (<zn-gate version>)
  update zn-gate: run `npm install -g zn-gate` in your own terminal, then run `zn-gate check` again
  ```

  Before it runs anything of the Claude Code plugin (`scripts/zn-node.sh`) or the ZCode plugin (`scripts/zn-hook.sh`), zn-gate check compares the script's sha256 with the versions zn has shipped. A script that was edited, replaced or damaged is not run, and the fix is to install the plugin again. When the plugin says it is newer than the zn-gate you run, zn-gate does not know its script yet: the line adds that the plugin is newer, and the fix is to update zn-gate (`npm install -g zn-gate`).

- **The hook starts PowerShell by name (Windows, written by an older zn-gate).**

  ```text
  its hook command starts powershell.exe by name (written by an older zn-gate), so a powershell.exe in the project folder could run in its place
  ```

  zn-gate 1.13 and earlier wrote Windows hook commands that start `powershell.exe` without its full path. Codex runs them through `cmd.exe`, and several agents start them directly; both look in the current folder first, which is usually the project. Run `zn hooks install <agent>` again: the new command names the system PowerShell by its full path.

- **The launcher script of the hook is gone.**

  ```text
  its hook cannot start: its launcher script (<path>) is missing or was changed
  ```

  A Codex CLI or Claude Code hook calls a small script that `zn hooks install <agent>` writes under `~/.zn/hooks`. If the script was deleted or edited, run `zn hooks install <agent>` again.

- **Antigravity runs the hook command without a shell, and the launcher path is in quotes.**

  ```text
  its hook cannot start: Antigravity runs the command without a shell, so the quotes around the launcher path (<path>) become part of the file name and the hook never runs
  ```

  An older zn-gate wrote the Antigravity launcher path in quotes. Antigravity does not read quotes, so the hook never starts. Run `zn hooks install antigravity` again: it writes the path without quotes.

- **zn's Antigravity hook is turned off.**

  ```text
  zn's hook is turned off in <file> ("enabled": false on the hook "<name>"), so Antigravity skips it and zn does not protect Antigravity
  ```

  Antigravity documents `"enabled": false` as a way to disable a hook without removing it, and then runs nothing for it. Fix: run `zn hooks install antigravity` in your own terminal (it turns the hook back on), or set "enabled" to true on that hook, then run `zn-gate check` again. If another enabled Antigravity hook also runs before tool calls, `zn-gate check` adds a note: Antigravity does not document the order of hooks or which answer wins, so zn cannot tell whether its deny holds against that hook.

- **Antigravity cannot start the hook command, for example because the home folder has a space.**

  ```text
  its hook cannot start: Antigravity runs the command without a shell, split on spaces, so this one (<command>) is cut in the wrong place and never runs
  ```

  Antigravity starts a hook by splitting the command on spaces, with no shell and no quotes, so a launcher path with a space in it (for example under `/Users/Jose Perez`) never starts. `zn hooks install antigravity` now refuses to write such a command. Choose a folder whose path has no spaces and run `ZN_HOOK_DIR=<that folder> zn hooks install antigravity` in your own terminal; the fix line says the same: if the path of your home folder has a space, choose a folder with no spaces and run `ZN_HOOK_DIR=<that folder> zn hooks install antigravity` in your own terminal; otherwise install zn-gate again and run `zn hooks install antigravity`.

- **The hook calls `zn`, and `zn` is not installed.**

  ```text
  its hook runs `zn`, and there is no `zn` on your PATH
  ```

  Same repair as above. You may have run zn-gate only with `npx`, which does not install the `zn` command.

- **The hook started but failed.**

  ```text
  its hook cannot start (<reason>)
  the installed hook did not block the read of .env
  the installed hook blocks everything, ordinary files too, so part of zn is missing or broken
  ```

  zn-gate ran the installed hook the way your agent runs it. The first line says it could not start, the second that it let the fake `.env` through, the third that it blocked even the ordinary file. For all three, reinstall zn-gate and the hooks as in the previous reason.

- **zn's own rules let the fake `.env` through.**

  ```text
  zn did not block the read of .env
  install zn-gate again: run `npm install -g zn-gate` in your own terminal, then run `zn-gate check` again
  ```

  The copy of zn-gate that is running does not block the file, so no setup can work until zn-gate is installed again.

### Claude Code plugin

- **The plugin is turned off.**

  ```text
  the zn-gate plugin is turned off in your Claude Code settings
  turn it on: run `claude plugin enable zn-gate@usezn` in your own terminal
  ```

- **The plugin is not where Claude Code installs plugins, or its hooks file does not have the hook the plugin ships.**

  ```text
  the zn-gate plugin listed in installed_plugins.json is in <folder>, which is not inside the folder where Claude Code installs plugins (<config folder>/plugins), so zn-gate check does not run it
  the zn-gate plugin listed in installed_plugins.json is in <folder>, inside this project (<project>), so zn-gate check does not run it
  the zn-gate plugin has no hook manifest zn-gate check can read (<plugin folder>/hooks/hooks.json), so nothing shows that Claude Code runs a zn check before tool calls
  the zn-gate plugin has no PreToolUse hook in <plugin folder>/hooks/hooks.json, so Claude Code runs no zn check before tool calls
  the PreToolUse hook of the zn-gate plugin in <plugin folder>/hooks/hooks.json runs in the background (async), where Claude Code does not wait for its answer, so Claude Code runs no zn check before tool calls
  the PreToolUse hook of the zn-gate plugin in <plugin folder>/hooks/hooks.json runs `<command>`, which is not the hook the zn-gate plugin ships (`/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code`), so Claude Code runs no zn check before tool calls
  the PreToolUse hook of the zn-gate plugin in <plugin folder>/hooks/hooks.json does not have "onFailure": "block", so Claude Code runs a call unchecked when the hook cannot run
  install the plugin again: run `claude plugin uninstall zn-gate@usezn`, then `claude plugin install zn-gate@usezn`, in your own terminal, then run `zn-gate check` again
  ```

  `installed_plugins.json` can name any folder, so `zn-gate check` starts nothing from the plugin until it knows the plugin is real: its folder must be inside `plugins` under your Claude Code configuration folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`), or inside `CLAUDE_CODE_PLUGIN_CACHE_DIR` when that is set, and not inside the project you run the check in. Its `hooks/hooks.json` must have the PreToolUse hook the plugin ships, exactly: a "command" hook whose command is `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code`, with `"shell": "bash"` and `"onFailure": "block"`, not turned off, not run in the background, and with a matcher that covers reading files. Any other command counts as no zn check, even one that runs another script of the plugin, because it may answer nothing and Claude Code would then run the call. The other forms of the PreToolUse line say that the hook is turned off, is not a "command" hook, does not ask for bash, or has a matcher that does not cover Read.

  The live test then runs that command the way Claude Code runs it: `/bin/sh` with the plugin's `scripts/zn-node.sh` and `PreToolUse hook claude-code` (on Windows, Git Bash runs the command line, as Claude Code does), with `CLAUDE_PLUGIN_ROOT` set to the plugin folder, `CLAUDE_PROJECT_DIR` set to the project you run the check in (the root of its git repository when there is one, also from a subfolder), your `PATH`, and the hook's timeout (at most 15 seconds). The plugin counts as protected only when that command blocks the `.env` file and allows the ordinary file. A command that answers nothing (exit 0) or cannot start is reported as **NOT protected**. On Windows without Git Bash, the line says so and suggests Git for Windows or zn's own hooks. Before that, zn-gate also runs the plugin's own start-up check (`/bin/sh` with the same script and `SessionStart check claude-code`) only to show its message, for example about a Node.js the plugin does not support; it never makes the plugin count as protected.

- **Windows: Git Bash was not found.**

  ```text
  Git Bash was not found, and Claude Code runs the hooks of the zn-gate plugin with it on Windows ("shell": "bash"), so the hook cannot start
  install Git for Windows (or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe), or use zn's hooks instead: run `npm install -g zn-gate`, then `zn hooks install claude-code`, then `claude plugin disable zn-gate@usezn`, all in your own terminal, then run `zn-gate check` again
  ```

  zn-gate looks for Git Bash the way Claude Code is set up: `CLAUDE_CODE_GIT_BASH_PATH`, else the `bin\bash.exe` next to `git` on your `PATH`, else `bash` or `sh` on your `PATH`.

- **The plugin needs a newer Node.js.**

  ```text
  the zn-gate plugin needs Node.js 20.19 or later (you have <version>)
  the zn-gate plugin needs Node.js 20.19 or later (Claude Code will run the hooks of the plugin with Node.js <version> (from <path>); zn-gate itself runs on Node.js <version>)
  the zn-gate plugin could not be checked: zn-gate could not find or run the `node` that Claude Code will start the hooks of the plugin with (the first one on your PATH)
  ```

  Node.js 18 and 19, 20 before 20.19 and 21 before 21.7 are too old for the plugin, which then refuses to start. Claude Code starts the plugin's hooks with the first `node` on its `PATH`, which can be a different Node.js from the one that runs zn-gate. The repair is one of two things:

  ```text
  update Node.js to 20.19 or later (the current LTS from nodejs.org), and make it the first `node` on your PATH, or use zn's hooks instead: run `npm install -g zn-gate`, then `zn hooks install claude-code`, and after that turn the plugin off with `claude plugin disable zn-gate@usezn`, all in your own terminal
  make sure `node --version` works in a new terminal and shows 20.19 or later, or use zn's hooks instead: run `npm install -g zn-gate`, then `zn hooks install claude-code`, and after that turn the plugin off with `claude plugin disable zn-gate@usezn`, all in your own terminal
  ```

  The second form is for a `node` that zn-gate could not run at all. More in [Troubleshooting](troubleshooting.md#11-the-claude-code-plugin-rejects-every-call-or-its-mcp-servers-show-failed-to-connect).

- **The plugin does not work, and zn's own hooks sit next to it.**

  ```text
  the zn-gate plugin does not work here (<reason>), while the hooks of `zn hooks install claude-code` next to it do
  turn the plugin off, which keeps those hooks: run `claude plugin disable zn-gate@usezn` in your own terminal, then run `zn-gate check` again
  ```

  If those hooks do not work either, the line says so and the repair has two steps, in this order, so your agent is never left with less protection than before:

  ```text
  the zn-gate plugin does not work here (<reason>), and the hooks of `zn hooks install claude-code` next to it do not work either (<reason>)
  first repair the hooks: run `npm install -g zn-gate`, then `zn hooks install claude-code`; after that, turn the plugin off with `claude plugin disable zn-gate@usezn`; all in your own terminal, then run `zn-gate check` again
  ```

- **Both the plugin and the hooks are installed.**

  ```text
  the zn-gate plugin and the hooks of `zn hooks install claude-code` are both set up, so both run, and a broken one can block every prompt
  remove the second set: run `zn hooks uninstall claude-code` in your own terminal
  ```

### Cursor plugin

- **A zn-gate plugin for Cursor is installed.**

  ```text
  the zn-gate plugin for Cursor is installed (<plugin folder>), and zn-gate no longer supports it: its hooks start `node` by name, so a PATH entry that points into a project can run a program of that project in place of zn
  run `zn hooks install cursor` in your own terminal, then remove the zn-gate plugin in Cursor (Customize, in the sidebar), then run `zn-gate check` again
  ```

  zn-gate looks for the plugin under `~/.cursor/plugins`, up to 8 folders deep and through links (Cursor keeps plugins you add by hand in `~/.cursor/plugins/local`): a folder counts when its `.cursor-plugin/plugin.json` is named `zn-gate` and points to github.com/usezn/zn. Other plugins there are ignored. Only that file is read; nothing of the plugin is run. The plugin is reported even when the hooks of `zn hooks install cursor` are installed too, because Cursor still runs its hooks:

  ```text
  the zn-gate plugin for Cursor is installed (<plugin folder>), and zn-gate no longer supports it: ..., while the zn hooks next to it (<hooks file>) work
  remove the zn-gate plugin in Cursor (Customize, in the sidebar), then run `zn-gate check` again
  ```

  If those hooks do not work either, the line says so (`..., and the zn hooks next to it do not work either (<reason>)`), and the repair is to fix the hooks first, then remove the plugin.

### A setting turns the hooks off

For these reasons, zn is installed correctly, but a setting stops your agent from running any hook. Your agent does not tell you. The repair for all of them is to change the setting the line names, then run `zn-gate check` again. If the line names an organization policy file, send the line to your administrator.

- **Claude Code.** The repair is always the same line, and the reason is one of the others:

  ```text
  change that Claude Code setting as it says, then run `zn-gate check` again
  <file> turns off all hooks (disableAllHooks), so zn's hooks do not run. Claude Code does not show this. Ask your administrator to add zn to the managed settings.
  <file> runs only the hooks in its managed settings (allowManagedHooksOnly), so the zn hooks you install do not run. Claude Code does not show this. Ask your administrator to add zn to the managed settings.
  <file> sets disableAllHooks, so no hooks you install run, zn's included. Remove that setting to turn them on.
  could not read the Claude Code managed settings <file> (<error>), so zn cannot tell whether they turn off its hooks.
  ```

  The first two start with `Your organization's Claude Code policy (<file>)`. The last one means zn-gate found a policy file it could not read. It cannot tell whether that file turns hooks off, so it does not call your agent protected. Fix the file or its permissions, or ask your administrator.

- **Codex CLI.** The repair is always the same line, and the reason is one of the others:

  ```text
  change that Codex setting as it says, then run `zn-gate check` again
  Your organization's Codex requirements (<file>) turn hooks off ([features] hooks = false), so zn's hooks do not run. Codex does not show this. Ask your administrator to allow zn's hooks.
  Your organization's Codex requirements (<file>) run only the hooks they manage (allow_managed_hooks_only), so the zn hooks you install do not run. Codex does not show this. Ask your administrator to allow zn's hooks.
  Your organization's Codex managed configuration (<file>) turns hooks off ([features] hooks = false) at every start, so zn's hooks do not run. Codex does not show this. Ask your administrator to allow zn's hooks.
  <file> turns hooks off ([features] hooks = false), so no hooks you install run, zn's included. Remove that line, or set it to true, to turn them on.
  ```

  The last one is your own `config.toml`: delete the line or set it to `true`. For the other three, ask your administrator.

- **A Codex file that zn-gate could not read** is not a NOT protected line. zn-gate does not know that the file turns hooks off, so it adds a note under an **OK** line instead:

  ```text
  could not read the Codex requirements <file> (<error>), so zn cannot tell whether they turn off its hooks.
  could not read the Codex managed configuration <file> (<error>).
  ```

  Check that the file exists and that your user can read it, then run the check again.

- **Cursor.** Cursor runs the hooks of every source (enterprise, team, project and user) and merges their replies, so an enterprise `hooks.json` never turns off the zn hooks you install. These lines are about that file (the notes under an **OK** line say the same):

  ```text
  The Cursor enterprise hooks <file> do not include zn's hook. They do not turn off the zn hooks you install: Cursor runs the hooks of every source and merges their replies, enterprise first. Run `zn team managed-config --agent cursor` to see what an administrator can add so zn fails closed.
  The Cursor enterprise hooks <file> have no zn hook with "failClosed": true under hooks.<event>, so if zn's hook crashes or times out Cursor lets the file read or prompt through. Ask your administrator to add it.
  ```

  The first one only tells you what the file does: nothing to repair. For the second one, send the line to your administrator, who adds `"failClosed": true` to zn's hook for that event.

### The Codex hook is set up wrongly

- **The hook runs in the background.**

  ```text
  zn's <event> hook runs in the background (async) in <file>, and a background hook cannot block anything, so zn does not protect Codex
  remove `async` from zn's hooks in that file, or run `zn hooks install codex` again, then run `zn-gate check` again
  ```

  A hook marked `async` in `hooks.json` or `config.toml` runs in the background, so Codex does not wait for its answer and it cannot stop the call.

- **The hook is switched off.**

  ```text
  zn's <event> hook is switched off in <file> ([hooks.state] enabled = false), so Codex skips it and zn does not protect Codex
  delete that [hooks.state] entry, or turn zn's hook back on in `/hooks` in Codex, then run `zn-gate check` again
  ```

  An `enabled = false` entry under `[hooks.state]` in `config.toml` makes Codex skip the hook without a message.

- **Another hook runs next to zn's.**

  ```text
  another hook runs before Codex calls (<event> in <file>); it can change a call after zn has checked it, so zn cannot fully protect Codex
  review that hook and remove it if you do not need it, or have your administrator manage hooks with `allow_managed_hooks_only`, then run `zn-gate check` again
  ```

  Codex runs every hook for an event at the same time, each with the original call. Another tool's hook can change the call after zn has checked it, or answer an approval prompt, and zn cannot see what it does. See [compat](compat.md) for the details.

### ZCode settings switch the hook off

- **Hooks are turned off.**

  ```text
  "hooks.enabled" is false in <file>, so ZCode runs none of the hooks in that file, zn's included
  "hooks.enabled" is not set in <file>, so ZCode runs none of the hooks in that file, zn's included
  run `zn hooks install zcode` in your own terminal (it turns the hooks back on), then run `zn-gate check` again
  ```

  ZCode runs no hook from `~/.zcode/cli/config.json` unless `hooks.enabled` is `true`, and it is off by default. The hooks of a ZCode plugin keep running when it is off, but zn's are not a plugin. Start a new ZCode session after the fix: a running session keeps the hooks it started with.

- **The zn-gate ZCode plugin is turned off, and nothing else of zn runs.**

  ```text
  the zn-gate plugin is turned off in ZCode, and the hooks of `zn hooks install zcode` are not installed, so nothing of zn protects ZCode
  the zn-gate plugin is turned off in ZCode, and "hooks.enabled" is false in <file>, so ZCode runs none of the hooks of `zn hooks install zcode` either and nothing of zn protects ZCode
  plugins are turned off in ZCode ("plugins.enabled" is false in <file>), so the zn-gate plugin does not run and no other zn hook protects ZCode
  turn the plugin on in ZCode (Settings, Plugins), or run `zn hooks install zcode` in your own terminal, then run `zn-gate check` again
  ```

  The plugin keeps protecting ZCode when `hooks.enabled` is off, but only while it is on. ZCode records the plugin's switch in `~/.zcode/cli/config.json` (`plugins.enabledPlugins`), and `plugins.enabled` turns every plugin off. With the plugin on and `zn hooks install zcode` as well, `zn-gate check` reports a note, not a problem: ZCode does not remove duplicate hooks, so every call is checked twice. Keep one of them.

- **One of zn's hooks is turned off.**

  ```text
  zn's <event> hook has "enabled": false in <file>, so ZCode skips it
  ```

  ZCode skips an entry with `"enabled": false` without a message. Run `zn hooks install zcode` again, or set it back to `true`, then run `zn-gate check` again.

- **One of zn's hooks runs in the background.**

  ```text
  zn's <event> hook runs in the background (async) in <file>, and a background hook cannot block anything
  ```

  A hook marked `async` runs beside the tool call and cannot stop it. Remove `"async": true` from zn's entry, or run `zn hooks install zcode` again.

- **ZCode's MCP support is off.** This is a note under an **OK** line, not a NOT protected line: `"features.mcp"` is false in <file>. We read that setting as "ZCode does not start zn's `secrets` MCP server", but we did not test what it does in the ZCode desktop app. The hooks still work.

### Gemini CLI settings switch the hook off

- **Hooks are turned off, or zn's hook is on the disabled list.**

  ```text
  <label> (<file>) turn all hooks off (hooksConfig.enabled is false), so zn's hook does not run. Set it to true to turn hooks on.
  <label> (<file>) list zn's hook in hooksConfig.disabled (for example after `/hooks disable`), so it does not run. Remove it from that list, or run `/hooks enable zn-gate` in Gemini CLI.
  change that Gemini CLI setting as it says, then run `zn-gate check` again
  ```

  `<label>` is your Gemini CLI settings, this folder's Gemini CLI settings or the system Gemini CLI settings. With `hooksConfig.enabled` set to `false`, Gemini CLI runs no hooks at all. A name in `hooksConfig.disabled` skips just that hook. Edit the file as the line says, then run the check again.

- **A Gemini CLI settings file that zn-gate could not read** is not a NOT protected line. It adds a note under an **OK** line instead:

  ```text
  could not read <file> (invalid JSON), so zn cannot tell whether it turns off its hooks.
  could not read <file> (<error>), so zn cannot tell whether it turns off its hooks.
  ```

  Fix the JSON or the file permissions, then run the check again.

### Copilot CLI settings switch the hooks off

- **zn's hooks file is switched off.**

  ```text
  zn's hooks file has "disableAllHooks" turned on, so Copilot skips it
  run `zn hooks install copilot` in your own terminal (it turns the hooks back on)
  ```

  Copilot CLI skips a hooks file that sets `disableAllHooks` to `true`, and says nothing. Running the install command again turns the hooks back on.

- **This folder's Copilot settings switch the hooks off.**

  ```text
  the Copilot settings of this folder (<file>) have "disableAllHooks" turned on, so Copilot runs no hook of yours here (only machine policy hooks)
  remove "disableAllHooks" from that file, then run `zn-gate check` again
  ```

  `<file>` is `.github/copilot/settings.json` or `.github/copilot/settings.local.json` in the folder where you ran the check. Remove the setting, or ask whoever owns the repository.

### zn-gate could not finish the check

```text
zn could not read its setup: <error>
zn could not check it: <error>
```

Something unexpected stopped the check for that agent, and the line gives the error. Nothing was changed. Run `npx -y zn-gate check` again; if it repeats, ask in [Discussions](https://github.com/usezn/zn/discussions) and include the line, without any secret.

## If something fails

- **`npx: command not found`**: install the LTS version of [Node.js](https://nodejs.org/), open a new terminal and run the command again.
- **A line starts with `-`**: zn is not set up for that agent. Run `npx -y zn-gate init`. It shows each step and asks before it runs one. If the line says *not found on this machine*, that agent is not installed and `init` does nothing for it.
- **A line says NOT protected**: read the line. It says what to run. If the Node.js your hook used was removed, run `npm install -g zn-gate`, then `zn hooks install <agent>`.
- **Still not sure**: re-run `npx -y zn-gate check`, then ask in [Discussions](https://github.com/usezn/zn/discussions).

## If your agent needs a value from `.env`

zn blocks the file because it holds secret values. To let your agent use them without seeing them, move the values into zn's vault:

```bash
zn env shadow .env
```

The file keeps markers such as `__ZN_API_KEY__` instead of the values, and zn gives the real values, as environment variables, only to the commands you allow. See [Secrets](secrets.md).

## Related

- `zn-gate test` runs zn's built-in rule self-test (51 examples). It checks the rules, not your agent setup.
- `zn-gate status` shows the active detection engine and whether the optional cloud check is on, and whether a key was saved by `zn-gate connect` (never the key itself). Sharing of usage statistics is off by default and has its own status: `zn-gate stats share status`.
