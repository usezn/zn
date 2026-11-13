# Example: set up zn-gate, then remove it, in a throwaway home folder

This page proves what [`zn-gate uninstall`](../uninstall.md) removes and what it leaves, without touching your real home folder. You point `HOME` at an empty temporary folder, set zn-gate up for one agent, write down every file, remove it, and compare the two lists. Your real settings, vault and projects are never involved. All values are made up, and your temporary folder name will differ.

The output below comes from a real run on Linux with zn-gate 1.15.0 and Codex CLI as the agent. Your home folder in the temporary session is shown as `~`. Run the commands yourself, in your own terminal: `init` and `uninstall` ask you questions and refuse to run when an AI agent or a script runs them. The commands are in the [command reference](../cli.md); the page about [files zn-gate writes](../files-and-folders.md) explains each folder.

Use this on a computer where you are happy to install and remove zn-gate for a test. Everything else is in the temporary folder.

## 1. Make the throwaway home

```bash
REAL_HOME="$HOME"
TEST_HOME="$(mktemp -d)"
export HOME="$TEST_HOME"
mkdir -p "$HOME/.codex" "$HOME/proj"
cd "$HOME/proj"
```

`mktemp -d` makes an empty folder. The empty `~/.codex` folder is all `init` needs to see Codex CLI on this machine. Keep this terminal window open for the whole page: `HOME` points at the throwaway folder only in this window.

zn-gate installs itself for your user with `npm install -g`. Give npm a global folder inside the throwaway home, as [Troubleshooting](../troubleshooting.md) suggests for permission errors:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```

This writes one line to `~/.npmrc` inside the throwaway home. It is npm's file, not zn-gate's.

## 2. Write down the empty state

```bash
cd ~ && find . -not -path './.npm/*' | sort > before.txt && cat before.txt
```

```text
.
./.codex
./.npm-global
./.npmrc
./proj
```

The `.npm` folder is npm's own cache and logs. It is left out of every list on this page because zn-gate does not own it.

## 3. Set up

```bash
cd ~/proj && npx -y zn-gate init
```

Answer `y` to the two questions: install zn-gate for your user, then install the hooks for Codex CLI. The part of the output that matters:

```text
  >  Codex CLI    not set up yet

install zn-gate 1.15.0 for your user: run `npm install -g zn-gate@1.15.0`? [y/N] y
Codex CLI:
  install zn's hooks for Codex CLI: run `zn hooks install codex`? [y/N] y
Installed zn hooks for codex in ~/.codex/hooks.json
```

`init` finishes by running `check`, which asks the new hook to block a fake `.env` in a test folder and then deletes that folder.

## 4. List everything that was created

```bash
cd ~ && find . -not -path './.npm/*' -not -path './.npm-global/lib/*' | sort > after-init.txt
diff before.txt after-init.txt
```

```text
2a3
> ./.codex/hooks.json
4a6,8
> ./.npm-global/bin
> ./.npm-global/bin/zn
> ./.npm-global/bin/zn-gate
> ./.npm-global/bin/zn-mcp
...
> ./.zn
> ./.zn/cache
> ./.zn/cache/compile
> ./.zn/cache/compile/v24.22.1-x64-964aae3f-1012
> ./.zn/cache/compile/v24.22.1-x64-964aae3f-1012/04aa0b00
(about two dozen small files in the same folder)
> ./.zn/evidence.jsonl
> ./.zn/hooks
> ./.zn/hooks/zn-hook-codex.sh
```

Reading the list:

| Path | What it is |
| --- | --- |
| `~/.npm-global/lib/node_modules/zn-gate` | The program, installed by npm (hidden from the list above; about 380 entries). |
| `~/.npm-global/bin/zn`, `zn-gate`, `zn-mcp` | The commands, installed by npm. |
| `~/.codex/hooks.json` | Zn's hooks for Codex CLI: seven events, each calling the launcher script. |
| `~/.zn/hooks/zn-hook-codex.sh` | The launcher script those hooks call. |
| `~/.zn/evidence.jsonl` | The [decision log](../cli.md#evidence): 25 lines, written by the fake-secret test that `check` runs. |
| `~/.zn/cache/compile` | Node.js's compile cache for the hooks. It only makes later hook calls start faster. |

No vault was made, because this page never stores a secret.

## 5. Preview the removal

```bash
cd ~/proj && zn-gate uninstall --dry-run
```

```text
zn-gate uninstall: what zn-gate set up on this computer

Will be removed:
  Codex CLI
    - zn's hooks for your user (and its "secrets" MCP server, if listed): ~/.codex/hooks.json

This was a dry run: nothing was changed.
```

Exit code `0`. The preview lists the hooks file. The launcher script is not listed here, but the real removal deletes it, as the next step shows.

## 6. Remove

```bash
zn-gate uninstall
```

Answer `y` to "Remove what is listed above?". Nothing in this setup needs the vault question, so it does not ask it.

```text
Remove what is listed above? [y/N] y
  Codex CLI: removed zn's hooks (user) in ~/.codex/hooks.json (copy saved: ~/.codex/hooks.json.bak-zn-20261111T114645)

  -  Codex CLI    zn is not set up for this agent. To protect it, run `zn hooks install codex` in your own terminal.
...
Last step, to remove the program itself: npm uninstall -g zn-gate
```

Exit code `0`. The final `check` now says zn is not set up for Codex CLI. The settings file got a saved copy before it was changed.

## 7. Compare

```bash
cd ~ && find . -not -path './.npm/*' -not -path './.npm-global/lib/*' | sort > after-uninstall.txt
diff after-init.txt after-uninstall.txt
cat ~/.codex/hooks.json
```

```text
3a4
> ./.codex/hooks.json.bak-zn-20261111T114645
41d41
< ./.zn/hooks/zn-hook-codex.sh
{}
```

The launcher script is gone. The hooks are gone from `hooks.json`, which is now an empty `{}`. The only new file is the saved copy of the settings. Everything else is still there: the program, `evidence.jsonl` and the compile cache.

## 8. Remove the program, then list what is left

The program is the last step, as `uninstall` told you:

```bash
npm uninstall -g zn-gate
cd ~ && find . -not -path './.npm/*' | sort
```

```text
.
./.codex
./.codex/hooks.json
./.codex/hooks.json.bak-zn-20261111T114645
./.npm-global
./.npm-global/lib
./.npm-global/lib/node_modules
./.npmrc
./.zn
./.zn/cache
./.zn/cache/compile
./.zn/cache/compile/v24.22.1-x64-964aae3f-1012
(about two dozen small files in the same folder)
./.zn/evidence.jsonl
./.zn/hooks
./proj
```

## What is left, and why

Compared with the empty list in step 2, these remain after both removal steps:

| Left behind | Why | Yours to delete? |
| --- | --- | --- |
| `~/.codex/hooks.json` (`{}`) | `hooks uninstall` removes zn's entries and keeps the file, which belongs to Codex CLI and may hold other settings. | Optional. It is harmless. |
| `~/.codex/hooks.json.bak-zn-<time>` | The copy saved before zn changed the file, so you can put it back. | Yes, once you are happy. |
| `~/.zn/evidence.jsonl` | The decision log. `uninstall` never deletes it, as the [remove page](../uninstall.md#4-your-env-files-and-the-vault) says. | Yes. |
| `~/.zn/cache/compile` | The hook's compile cache, which Node.js fills when a hook runs. `uninstall` does not remove it. | Yes. |
| `~/.zn/hooks` (empty) | The launcher script was deleted, its folder was not. | Yes. |
| `~/.npm-global/…` (empty folders), `~/.npmrc`, `~/.npm` | npm's own files, from steps 1 and 3. | They are npm's, not zn-gate's. |

Zn-gate's own list is therefore short: the decision log, the compile cache, one empty folder and one saved copy. No hook, launcher script, command or program remains, and `zn-gate check` reports none. If you want the `.zn` folder gone as well, delete it by hand: `rm -rf ~/.zn` (inside the throwaway home, this is safe).

## 9. Throw the home away

Put your real home folder back, check that the variable points at the throwaway folder, then delete it:

```bash
export HOME="$REAL_HOME"
cd ~
echo "$TEST_HOME"
rm -rf "$TEST_HOME"
```

Read the path that `echo` prints before you run the last line: `rm -rf` cannot be undone.

## Full pages

- [Remove zn-gate](../uninstall.md), including [what each command removes and leaves](../uninstall.md#what-each-command-removes-and-leaves)
- [Files and folders zn-gate reads or writes](../files-and-folders.md)
- [Example: set up zn-gate, preview, then remove it](init-and-uninstall.md)
- [Example: remove the hooks, then check that they are gone](hooks-uninstall-then-verify.md)
- [All examples](README.md)
