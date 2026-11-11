# Example: install the hooks on a locked-down laptop

Some computers are set up so that you cannot install programs for everyone, or cannot write in some folders. This page walks through the cases that matter for `zn-gate hooks install`: no rights to install a global npm package, a settings folder you cannot write to, and a network that goes through a proxy. Every message below is real output. All paths in the messages are shortened to the part that matters, and all values are made up.

Run the commands in your own terminal, not through your agent. The install needs an interactive terminal; without one it exits with code `77` and changes nothing.

## 1. What the install writes, and where

For your own user, `hooks install` writes in your home folder only, so it needs no administrator rights:

- the settings file of the agent (for Claude Code, `~/.claude/settings.json`), after making a backup next to it;
- a small launcher script in `~/.zn/hooks`.

It does not write anywhere else, and it does not need `zn` on your `PATH`. See [`hooks install`](../cli.md#hooks-install).

```bash
npx -y zn-gate hooks install claude-code
```

```text
Installed zn hooks for claude-code in ~/.claude/settings.json
  backup: ~/.claude/settings.json.bak-zn-20261111T134852
```

Then check them:

```bash
npx -y zn-gate check --hooks
```

```text
6 OK, 0 stale, 0 broken.
```

On a laptop where `zn` is not on the `PATH`, the six hooks still read `OK`, and `npx -y zn-gate check` says that Claude Code "blocked the .env file and allowed the ordinary file". Both commands only read files and use a temporary folder of their own. See [List every installed hook](../check.md#list-every-installed-hook).

## 2. No rights to install a global package

You do not need a global install for the steps above, because `npx -y zn-gate` runs zn-gate without one. If you do want `zn` on your `PATH`, and `npm install -g zn-gate` fails with `EACCES`, do not use `sudo`. Give npm a folder of your own:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
npm config get prefix
```

The second command prints the folder you set (here your home folder plus `/.npm-global`), and `npm config set` writes the line `prefix=...` to `~/.npmrc`. Add `~/.npm-global/bin` to your `PATH`, open a new terminal and install again. The full steps, including the `PATH` line, are in [npm says EACCES when init installs zn-gate](../troubleshooting.md#npm-says-eacces-when-init-installs-zn-gate).

## 3. A project install needs `zn` on the PATH

`--project` writes the hooks into the current project instead of your user settings, which is useful when the user folder is off limits. Run it from the project folder:

```bash
npx -y zn-gate hooks install claude-code --project
```

When `zn` is not on the `PATH`, it says so at once:

```text
Installed zn hooks for claude-code in <project>/.claude/settings.json
  note: a project install adds no MCP server: to use zn's secrets tools in Claude Code, run `zn hooks install claude-code` (your user settings)
  note: `zn` is not on your `PATH`, and this project install runs `zn hook claude-code`: until zn-gate is installed globally (npm i -g zn-gate, or pip install zn-gate), the hooks fail here and Claude Code may block every tool call or skip the secret checks. Everyone who uses the project needs zn on their PATH.
```

`npx -y zn-gate check --hooks` agrees, and exits with code `1`:

```text
Claude Code (project): <project>/.claude/settings.json
  BROKEN PreToolUse ...
  BROKEN: its hook runs `zn`, and there is no `zn` on your PATH.
    Fix: run `zn hooks install claude-code --project` in your own terminal.

6 OK, 0 stale, 6 broken.
```

(The first six `OK` lines are the user install from step 1.) Without a global `zn`, prefer the user install. If you cannot have either, remove the project hooks again with `npx -y zn-gate hooks uninstall claude-code --project` rather than leave hooks that fail.

## 4. A folder you cannot write to

When the folder of the settings file is read-only for you, the install stops before it changes anything:

```text
zn hooks: Your account is not allowed to read or change ~/.claude/settings.json. Check who owns it and its permissions, then try again.
```

Nothing is half written: no launcher and no backup was created, and `npx -y zn-gate check --hooks` still says `None found`. Add `ZN_VERBOSE=1` to see the system's error code next to the message (`[EACCES]` here). If your whole home folder is read-only, the message names `~/.zn/hooks` instead, because that is the first place the install writes.

On macOS or Linux, `ls -ld <path>` shows who owns the folder and who may write to it. Fix the permissions, or ask the person who manages the laptop, and run the install again. After the fix, the same command works. A settings file that is read-only but sits in a folder you can write to was replaced without complaint in the test, with a backup: do not rely on a read-only file to keep zn out. See [Messages about files and folders](../troubleshooting.md#messages-about-files-and-folders).

## 5. A proxy or VPN

`hooks install` itself needs no network. A proxy matters when the install of the package or the optional cloud check needs the internet. If npm cannot reach the registry through your proxy or VPN, `npx -y zn-gate init` says "no internet connection: npm could not reach the registry"; check the connection and run it again. See [init says there is no internet connection](../troubleshooting.md#init-says-there-is-no-internet-connection). If your company needs a proxy with its own certificate, zn-gate keeps its local checks and does not send a saved API key over that connection; see [the TLS settings message](../troubleshooting.md#8-will-not-send-the-saved-key-tls-settings).

## 6. When an administrator manages the settings

On a managed laptop, the settings of your coding agent may come from your organization, and a policy that turns off hooks stops zn's hooks from running. `npx -y zn-gate check` tells you when that is the case. Send the message to the administrator; [Team managed config](team-managed-config.md) shows what they can deploy.

## Where to read more

- [`hooks install`](../cli.md#hooks-install) in the command line reference
- [Install, verify and uninstall by agent](../by-agent.md)
- [Editors and coding agents](../editors/README.md)
- [Troubleshooting](../troubleshooting.md)
