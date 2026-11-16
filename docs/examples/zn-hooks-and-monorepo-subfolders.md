# Example: hooks and monorepo subfolders

A monorepo has one `.git` folder and many project folders under it, for example `packages/app` and `packages/lib`. This page shows which hooks zn-gate installs and lists when you work in one of those subfolders, and which folder each kind of setting is read from. The example uses Claude Code and made-up folder names. Run the commands in your own terminal, not through an AI agent. The commands are in the [command reference](../cli.md#hooks) and in [Check that it works](../check.md#list-every-installed-hook).

The layout:

```text
my-repo/
  .git/
  packages/
    app/
    lib/
```

## 1. The user install covers every folder

```bash
zn hooks install claude-code
```

With no option, zn changes your user settings (`~/.claude/settings.json` for Claude Code). That file does not depend on the folder you run the command in, so one run is enough for `my-repo`, `packages/app`, `packages/lib` and every other project on the machine.

`zn check --hooks` lists these hooks from any folder, because the user file is always read:

```bash
cd my-repo/packages/lib
zn check --hooks
```

```text
Claude Code (user): ~/.claude/settings.json
  OK     PreToolUse [...]  '~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse
  ...
6 OK, 0 stale, 0 broken.
```

This is a real run with the six hook lines cut to one and the folder names shortened.

## 2. `--project` uses the folder you are in

```bash
cd my-repo/packages/app
zn hooks install claude-code --project
```

```text
Installed zn hooks for claude-code in my-repo/packages/app/.claude/settings.json
```

The project file goes into the **current folder**, not into the top of the repository: zn does not walk up to `.git` for this. The same command run from `my-repo` writes `my-repo/.claude/settings.json` instead. After both runs the repository holds two separate files:

```text
my-repo/.claude/settings.json
my-repo/packages/app/.claude/settings.json
```

For the other agents the file has a different name (see the table in [install and uninstall the hooks of one agent](hooks-install-and-uninstall.md#2-or-install-them-for-one-project-only)), but the rule is the same: the folder you ran the command in.

## 3. `check --hooks` reads one project folder: the one you run it in

The project hooks of section 2 are in `packages/app`. Look from there:

```bash
cd my-repo/packages/app
zn check --hooks
```

```text
Claude Code (project): my-repo/packages/app/.claude/settings.json
  OK     PreToolUse [...]  zn PowerShell hook script
  ...
6 OK, 0 stale, 0 broken.
```

Now look from the sibling folder `packages/lib`, or from the top of the repository:

```bash
cd my-repo/packages/lib
zn check --hooks
```

```text
  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.
```

Both places print that line. `check --hooks` reads your user settings and the project settings of the folder it runs in, and nothing else: no parent folder and no sibling folder. "None found" says there is no zn hook in those two places. It does not tell you whether an agent opened in that folder also reads a settings file from a parent folder: that is decided by the agent, so read its own documentation, and keep the hooks where you know they are read.

When a hook in a project file is not `OK`, the `Fix:` line gives the command, with `--project`. Run it from the folder that holds the file.

## 4. Remove them from the same folder

```bash
cd my-repo/packages/app
zn hooks uninstall claude-code --project
```

```text
Removed zn hooks for claude-code in my-repo/packages/app/.claude/settings.json
  backup: my-repo/packages/app/.claude/settings.json.bak-zn-<date>
```

Only that file changes. The file `my-repo/.claude/settings.json` stays until you run the same command from `my-repo`.

## 5. Where other project settings are read from

The folder rule is not the same for everything zn reads.

- **Project root.** For per-project data, zn takes the nearest parent folder that holds a `.git` entry, and the folder itself when there is none. This is the "project root" of the [glossary](../glossary.md). A subfolder of `my-repo` is part of the project `my-repo`.
- **Your own project rules (`.znrules` or `zn.config.json`).** zn reads these from the folder it runs in, with no walk up to the top of the repository. In a real test, a `.znrules` file at the top of `my-repo` held the made-up word `forbidden-demo-word`, and a check of the text "please run forbidden-demo-word now" gave:

  ```text
  run from my-repo:               "verdict":"block", "reason":"Matches custom repository rule: forbidden-demo-word"
  run from my-repo/packages/app:  "verdict":"allow"
  ```

  So if your agent runs zn from a package folder, put the rules file in that folder too, or open the agent at the top of the repository.
- **zn's own settings** (the `hooks` section of `config.json`) are read from the `.zn` folder in your home, not from the project.

## More

- [Install and uninstall the hooks of one agent](hooks-install-and-uninstall.md): user settings and project settings, step by step.
- [`hooks` in the command reference](../cli.md#hooks)
- [List every installed hook](../check.md#list-every-installed-hook)
- [Glossary: project root](../glossary.md)
