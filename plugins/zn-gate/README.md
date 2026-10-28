# zn-gate plugin

zn-gate is a local security layer for coding agents. This plugin connects an
agent to zn-gate: hooks that keep secret values out of tool calls, tool output
and prompts, and a skill that explains them to the agent. Since version 1.14.0
the plugin registers no MCP server: its servers started `node` by name, so a
`node` of the project could start before anything was checked. To use the
`secrets` MCP server, run `zn hooks install claude-code` (zn-gate installed
with npm), which adds it with Node.js by its full path.

The plugin follows the [Agent Plugins 1.0](https://github.com/agentplugins/agent-plugins-spec)
layout (`plugin.json`, `skills/`) and adds the files Claude Code
and Codex read for hooks. Since version 1.14.0 there is no Cursor plugin: use
`zn hooks install cursor` instead.

**Codex:** this plugin declares zn-gate's hooks. Codex documents plugin hooks as loaded after you review and trust them in `/hooks` ([OpenAI hooks documentation](https://learn.chatgpt.com/docs/hooks)). In our test with Codex 0.162.1 we could not confirm that they load. If `/hooks` does not list zn-gate's hooks, run `zn hooks install codex` instead, which writes them into your Codex configuration; that is the tested path. The plugin's hooks need zn-gate 1.13.1 installed on the machine (`npm install -g zn-gate@1.13.1`, then `npm audit signatures`); without it, every tool call is refused. Use one set of hooks only. `com.openai/hooks.json` declares the plugin's hooks.

If you installed them earlier with `zn hooks install codex`, remove them with `zn hooks uninstall codex` (add `--project` if you installed them per project).

Hook scripts run on your machine: installing the plugin on the web does not install them.

## Requirements

- Node.js 20.19 or later, on your `PATH` (`node --version`). The native Claude
  Code installer does not include Node.js. Without it, Claude Code reports at
  session start that `node` was not found, and prompts, tool calls and typed
  commands are blocked (Claude Code 2.1.295 and later; earlier versions let
  them through unchecked). Install Node.js from https://nodejs.org and restart
  Claude Code (the terminal or the desktop app). On Ubuntu and Debian,
  `apt install nodejs` can give Node.js 18 (Ubuntu 24.04 does), which is too
  old: use a current LTS from nodejs.org.
- The native Claude Code installer (`curl -fsSL https://claude.ai/install.sh | bash`)
  puts `claude` in `~/.local/bin`. If `claude` is "command not found", add that
  folder to your `PATH` (`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`)
  and open a new terminal.
- Git (on Windows, Git for Windows), to add the marketplace from GitHub.
  Without it, `claude plugin marketplace add` fails because Git is not found.
- Claude Code on Windows: Git Bash (it comes with Git for Windows). The hooks
  ask Claude Code for bash (`"shell": "bash"`) and start through `/bin/sh`,
  which is Git Bash's. Without Git Bash they cannot start, and tool calls and
  prompts are blocked (not tested on Windows without Git Bash). If you cannot
  use Git Bash, do not install the plugin: run `zn hooks install claude-code`
  instead. If Claude Code still ran these hooks with PowerShell, `/bin/sh`
  would mean a `\bin\sh` program at the root of the project's drive, which
  another user of the machine may be able to create: on a shared Windows
  machine without Git Bash, do not install the plugin.
- Codex on Windows: the plugin does not run there. Its Windows hook commands
  only block tool calls and prompts and tell you to run
  `zn hooks install codex` instead of the plugin.
- zn-gate **1.13.1**.
  - **Claude Code** installs it with the plugin: it runs your `npm` to install
    the release pinned by the plugin's `package-lock.json` (with its registry
    integrity) into the plugin folder, with install scripts disabled. This
    needs npm on your `PATH`; without it the install is skipped, and the
    session start check says what to run.
  - **Codex and other agents** do not install plugin dependencies.
    Install the release yourself, then check the registry signatures of what
    you installed:

  ```bash
  npm install -g zn-gate@1.13.1
  npm audit signatures
  ```

  In Windows PowerShell, `npm` can fail with "running scripts is disabled on
  this system", because the default execution policy blocks `npm.ps1`. Use
  `npm.cmd` (and `zn.cmd`) instead (for example
  `npm.cmd install -g zn-gate@1.13.1`), run the
  commands from Command Prompt, or allow local scripts for your account with
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

  `npm audit signatures` checks the npm registry signature of every installed
  package and, for releases published with npm provenance, the attestation
  that links the package to its source commit in `usezn/zn`.

## Where it protects you

- **Claude Code** in the terminal, the IDE extensions and local sessions in
  the Code tab of the Claude desktop app: the hooks.
  The Code tab uses the plugins installed with `claude plugin install`.
  Claude Code sessions that run in the cloud (Claude Code on the web, cloud
  sessions in the Code tab) do not load plugins installed on your machine, so
  they are not protected.
- **Cowork**: zn has not verified the plugin in Cowork. Cowork takes its
  plugins from Customize > Plugins in Claude, not from `claude plugin
  install`. In a test where a Cowork task ran in the cloud workspace, a prompt
  containing a secret was not blocked and reached the model. **Do not rely on
  the plugin in Cowork.**
- **Chat** (claude.ai, the chat in the desktop app, mobile apps): this plugin
  is not loaded there and hooks do not run there, so **the plugin does not
  protect chat conversations**. Do not paste secrets into chat.

## What the plugin runs

Every hook runs `node scripts/zn-launch.js`, a single
file with no dependencies that you can read in full. Claude Code and Codex run
hooks in your project folder, so there the hooks start it through
`/bin/sh scripts/zn-node.sh`, which uses a Node.js found only in an absolute
`PATH` entry outside the project or a usual install folder: a `node` in the
project folder, its git work tree or a `node_modules` folder, or reached
through a relative or empty `PATH` entry, never runs in its place. If
it finds no Node.js, calls and prompts that zn cannot check are blocked, and
the other events show a warning. On every call the launcher:

1. finds the zn-gate package: the directory set as
   `"plugin": {"packageDir": "..."}` in `~/.zn/config.json`, or else the copy
   in the plugin folder (`node_modules/zn-gate`, installed by Claude Code),
   then each `zn-gate` executable on your `PATH` in turn (npm global layouts);
2. requires exactly version 1.13.1;
3. reads the whole package directory and requires it to hold exactly the files
   listed in `scripts/zn-gate.lock.json`, each with the SHA-256 digest of the
   published release: no extra file or directory, no symbolic link, nothing
   missing;
4. loads zn-gate's hook runner from the bytes it just checked,
   held in memory, with a module loader that only resolves to those files.

The lock file is generated from the published npm tarball after checking the
registry's sha512 integrity, and reviewed with each plugin release. The full
check runs on every call; `plugins/tools/bench-launch.js` in the repository
measures what that adds per hook call.

If anything fails, including an error inside zn-gate, the hooks refuse the
call or prompt and say how to fix it (exit code 2). To let events pass while zn-gate is unavailable instead, set
`{"hooks": {"whenUnavailable": "allow"}}` in `~/.zn/config.json` (the file in
your account's home directory; `$HOME` does not change which file is read).

What the hooks do with each event (deny reads of credential files, replace
secret values in tool output with tokens, block prompts that contain a
secret) is described in [docs/secrets.md](https://github.com/usezn/zn/blob/v1.13.1/docs/secrets.md),
and what each agent allows in [docs/compat.md](https://github.com/usezn/zn/blob/v1.13.1/docs/compat.md).

## Limits

The plugin reduces what a prompt-injected agent can do through its own tools.
It is not a sandbox:

- **Each hook call costs more.** The full check runs on every call. In CI
  (`plugins/tools/bench-launch.js`, 478 files, 5.6 MiB) it added a median of
  15 to 27 ms per hook call on Linux and macOS and 51 to 90 ms on Windows, on
  top of the 42 to 92 ms that zn-gate's hook takes without the plugin.
- **Node.js API.** The launcher loads ES modules through
  `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, which Node's documentation
  marks as experimental. If a Node.js version lacks it or changes it, the
  launcher refuses to run (hooks exit 2).
- **Timeouts in Claude Code.** A hook that does not answer in 15 s fails.
  The `PreToolUse`, `UserPromptSubmit` and `UserPromptExpansion` hooks
  carry `onFailure: "block"`, so on Claude Code 2.1.295 and later (which
  the plugin needs) the call or the prompt is blocked. On `SessionStart`
  and `PostToolUse` a timeout is a non-blocking error: after a tool has
  run, its output reaches the model without zn's scrubbing.
- **Refused output.** When the launcher refuses a tool-output event (the
  package was changed, zn-gate failed), it replaces the output with
  `[zn plugin: output withheld because zn could not check it]` in Claude Code.
- **The agent's environment.** Whoever controls the environment the agent
  starts hooks with chooses, through the absolute entries of its `PATH` (outside
  the project), which
  `node` runs the launcher, can preload code
  with `NODE_OPTIONS` before the launcher starts, and chooses the `PATH` used to
  find zn-gate (only an exact copy of the pinned release passes the check). The
  launcher removes `NODE_OPTIONS` and `NODE_PATH` before zn-gate starts any
  child process.
- **PATH entries the hooks trust.** The hooks skip `PATH` entries inside the
  project, but not when the session runs in your home folder, and not entries
  in `/tmp` or other folders the agent can write outside the project. If the
  only Node.js is inside the project (a toolchain such as devbox or hermit, or
  `node_modules/.bin`), the plugin finds no Node.js and blocks the calls it
  cannot check: use `zn hooks install <agent>` instead.
- **Files outside the in-memory load.** Child processes that zn-gate starts
  (the vault daemon, `zn run`, the stream scrubber) and the ES modules of its
  bundled dependencies are read from disk by Node after the check, so a change
  made between the check and that read is not seen.
- **Your own files.** Code that runs as you can change this plugin, the
  installed package or `~/.zn/config.json`. zn's hooks deny the agent's file
  tools and recognizable shell commands access to `~/.zn`, but a program the
  agent writes and runs is not inspected.

## What leaves your machine

Nothing. The hooks and the scrubber run locally and make no network
requests. zn-gate also has an optional cloud prompt analysis (`zn analyze`,
enabled only with `ZN_CLOUD=1` and an API key, sending prompt text with
secrets redacted first); the plugin's hooks never use it. Before version
1.14.0 the plugin also started a `zn-gate` MCP server, which used an optional
API key setting for that analysis; that server and the setting are gone, and
Claude Code may keep a key you entered with its own credentials: remove it
with `/plugin` (Installed, zn-gate, Configure options) before you update, or
leave it, since nothing reads it.

## Updates

The plugin is pinned to zn-gate 1.13.1 and has no auto-update. A new zn-gate
release comes with a new plugin release that pins it, with new file digests.
Upgrade on purpose, after reading the release notes. In Claude Code,
`claude plugin update zn-gate@usezn` installs the newly pinned zn-gate with
the plugin. In other agents, install the release first:

```bash
npm install -g zn-gate@X.Y.Z
npm audit signatures
```

## Install

Claude Code, from a marketplace pinned to the release tag:

```bash
claude plugin marketplace add usezn/zn@v1.13.1
claude plugin install zn-gate@usezn
```

Codex, Cursor (`zn hooks install cursor`, no plugin) and OpenCode: see [plugins/README.md](https://github.com/usezn/zn/blob/v1.13.1/plugins/README.md).

If you used `zn hooks install claude-code` before, remove those hooks so each
event is not checked twice: `zn hooks uninstall claude-code`.

## Files

| Path | Read by | Purpose |
| --- | --- | --- |
| `plugin.json`, `skills/` | Agent Plugins clients | Manifest, skill |
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | Claude Code | Manifest, hooks |
| `package.json`, `package-lock.json` | Claude Code | The pinned zn-gate release, installed into the plugin folder |
| `com.openai/hooks.json` | Codex | Hooks, loaded after you trust them in `/hooks` |
| `scripts/zn-launch.js` | all | Finds and verifies zn-gate, then runs it |
| `scripts/zn-gate.lock.json` | all | Pinned version and file digests |

## Security

Report vulnerabilities to security@usezn.com or through GitHub private
vulnerability reporting on `usezn/zn`; see
[SECURITY.md](https://github.com/usezn/zn/blob/v1.13.1/SECURITY.md).

## License

MIT
