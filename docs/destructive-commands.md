# Destructive commands

zn-gate can refuse a small set of shell commands that wipe a machine or run a download unread. Two of the rules are **on by default** in the agent hooks: `rm_root_home` (a recursive delete of the home folder, the filesystem root or a system folder) and `disk_overwrite` (a write to a disk device). The other four rules (`pipe_to_shell`, `rc_download`, `perm_root`, `fork_bomb`) are **off by default** and you can turn them on. You can also turn the two default rules off.

It is a guardrail against a model's mistake or a bad suggestion, not a sandbox. It reads the text of one command and blocks it only when the command has one of the shapes below.

When a command is blocked, it does not run, and the agent is told why and to ask you to confirm before it runs the command. If you do want it, run it yourself in a terminal.

## Change the settings

For the agent hooks (Claude Code, Codex CLI, Cursor, OpenCode and the others `zn hooks install` supports), set `hooks.blockDestructiveCommands` in `~/.zn/config.json`:

| Setting | Rules applied |
| --- | --- |
| not set | `rm_root_home` and `disk_overwrite` (the default) |
| `true` | all six rules |
| `false` | none: the check is off |
| a list of rule names, for example `["rm_root_home", "pipe_to_shell"]` | exactly those rules |

```json
{"hooks": {"blockDestructiveCommands": false}}
```

The environment variable `ZN_BLOCK_DESTRUCTIVE=1` turns on all six rules. The environment can only add protection, never remove it: `ZN_BLOCK_DESTRUCTIVE=0`, any other value, or no value is ignored and leaves the file (or the default) in charge. An environment variable can be set by a project an agent works in, so turning rules off is only possible from the config file, which the agent's file tools cannot write (they cannot write to `~/.zn`).

When the check applies, the hooks use it on the shell tools (Bash, PowerShell and monitors).

In your own code, call the function directly. Calling it is the opt-in: it always applies all six rules.

- Node.js: `checkCommand(command)` from `zn-gate/lib/client`
- Python: `check_command(command)` from `zn_gate`

Both return the same result as `evaluate`, with a rule such as `destructive:rm_root_home`. See the [API reference](api-reference.md). The settings above apply to the agent hooks only.

## What it blocks

| Rule | Default | Blocks | Examples |
| --- | --- | --- | --- |
| `rm_root_home` | on | Recursive delete of the home folder, the filesystem root, a top-level system folder or a drive root. Also `find` with `-delete` or `-exec rm` on those paths and no test such as `-name`. Also the one-liners `python -c`, `node -e`, `perl -e` and `ruby -e` that call a recursive delete (`shutil.rmtree`, `fs.rmSync` with `recursive`, `remove_tree`, `FileUtils.rm_rf`, `unlink glob`) on one of those paths. | `rm -rf ~`, `rm -rf $HOME/*`, `rm -rf /`, `rm -rf /usr`, `rm -rf /home/alice`, `Remove-Item -Recurse -Force $env:USERPROFILE`, `rd /s /q C:\` |
| `pipe_to_shell` | off | A download that is run as a script without being read, or into `python`, `node`, `perl` or `ruby` when it reads the program from the pipe (`curl ... \| python3`, `\| sudo python3 -`); `\| python3 -m json.tool` and `\| python3 script.py` are fine. | `curl https://example.com/install.sh \| sh`, `wget -qO- ... \| sudo bash`, `sh -c "$(curl ...)"`, `bash <(curl ...)`, `iwr ... \| iex` |
| `disk_overwrite` | on | `dd` with `of=` a block device, `mkfs`, `mkswap`, `wipefs`, `shred` or `blkdiscard` on one, a redirect into one, PowerShell `Format-Volume` and `Clear-Disk`. | `dd if=/dev/zero of=/dev/sda`, `mkfs.ext4 /dev/nvme0n1p2`, `cat /dev/zero > /dev/sda` |
| `perm_root` | off | `chmod -R`, `chown -R` or `chgrp -R` on the filesystem root or a top-level system folder; `chmod -R` with a world-writable mode on the home folder. | `chmod -R 777 /`, `chown -R nobody /usr`, `chmod -R 777 ~` |
| `fork_bomb` | off | The classic shell fork bomb, under any function name. | `:(){ :\|:& };:` |
| `rc_download` | off | A download written into a shell startup file (`.bashrc`, `.zshrc`, `.profile`, `/etc/profile`, fish `config.fish`, PowerShell `$PROFILE`). | `curl -o ~/.bashrc https://example.com/rc`, `curl ... \| tee -a ~/.zshrc` |

"Top-level system folder" means `/bin`, `/boot`, `/dev`, `/etc`, `/home`, `/lib`, `/opt`, `/root`, `/sbin`, `/srv`, `/sys`, `/usr`, `/var`, and on macOS `/Users`, `/System`, `/Library`, `/Applications`. A deeper path such as `/var/lib/apt/lists` or `/usr/local/lib/node_modules/x` is not blocked.

The command is split the way the rest of zn-gate's hook policy splits it, so quotes, `&&`, `;`, pipes, `sudo`, `nohup` and similar wrappers are understood, and `env` is understood in its plain form. `env -S` with a split command line is not; see [What it does not do](#what-it-does-not-do). The code of `sh -c`, `bash -lc`, `eval`, `pwsh -Command` and `cmd /c` is checked too, up to three levels deep. Text that only mentions a command inside quotes (`echo "rm -rf ~"`, a commit message) is not blocked.

## What it does not do

The check reads command text only. These are **not** covered, and the check lets them through:

- A path the command builds at run time: `rm -rf "$DIR"` with an empty `DIR`, `rm -rf *` in an unknown folder, or a target that comes from a pipe (`echo ~ | xargs rm -rf`).
- A program or shell named by a variable set earlier on the same line (`C=curl; $C https://example.com/i.sh | sh`): the value is not followed. Quoting that bash decodes before it runs the word (`$'\x63url'`, `c\url`) is read.
- A script saved first and run later (`curl -o x.sh ... && sh x.sh`), or a download piped into an interpreter that is given a script file (`curl ... | python3 script.py`, which only reads the download as data).
- Other tools (`rsync --delete`, `git clean`), code in a file or built at run time (a script the agent wrote, `python3 -c "shutil.rmtree(path)"` with a variable), and paths below the top level (`rm -rf /usr/local`).
- Commands that run inside a container (`docker run ... rm -rf /`) or on another machine (`ssh host "rm -rf /"`).
- A function defined and called on one line, such as `f() { ls; }; f`. A destructive command as the body of such a function is not blocked.
- `coproc`, such as `coproc ls`, or a group after it, such as `coproc { ls; }`. A destructive command after `coproc` is not blocked.
- `env -S` with a split command line, such as `env -S "ls -la"`. A destructive command given to `env -S`, in double or single quotes, is not blocked.
- Anything an agent does by writing a file and then running it.

For those, use a sandbox, a container or your agent's own permission prompts. This check adds a cheap last barrier for the most common catastrophic mistakes.

Untrusted code should run in a sandbox, such as a container or a virtual machine, not on your own machine. This check does not contain code that you do not trust.

## How well it works

The test corpus has about 1,000 ordinary developer commands (builds, git, package managers, containers, `rm -rf node_modules dist build target .venv`, `curl -o`, `curl | jq`, edits to `.bashrc`, and many that sit close to the blocked shapes) and about 650 commands with the blocked shapes, written from templates with varied flags, targets and fictitious hosts. On that corpus there are no false positives and no misses. The corpus does not include the three wrapper forms listed under [What it does not do](#what-it-does-not-do) (a function defined and called on one line, `coproc`, and `env -S`), so those forms are not measured by it. The corpus is written by the same people who wrote the rules, so read it as a regression test, not as an error rate on all real commands. Run `node bench/destructive_policy.js` in the repository to see the numbers, and `--docs` to also check the shell lines of the repository's documentation.

Cost: about 5 microseconds per command for the check itself, and a few microseconds more for a hook decision, which takes about 160 microseconds without it. The check code is loaded the first time a shell command is checked, and not at all when you turn the check off.

## How to read a blocked-command message

A block tells you two things: the command did not run, and which rule matched. Use the rule name to find the matching row in [What it blocks](#what-it-blocks). The rule name appears with a `destructive:` prefix, for example `destructive:rm_root_home`.

- `destructive:rm_root_home` for `rm -rf ~`: a recursive delete of the home folder. It is on by default.
- `destructive:disk_overwrite` for `dd if=/dev/zero of=/dev/sda`: a write to a disk device. It is on by default.
- `destructive:pipe_to_shell` for `curl https://example.com/install.sh | sh`: a download run without being read. It is only active if you turned it on.

If the command was what you meant, the agent will ask you to confirm; run it yourself in a terminal. If the command was a mistake, tell the agent what you actually want. If a rule blocks work you do often, see [Change the settings](#change-the-settings). For commands the check does not cover, see [What it does not do](#what-it-does-not-do).

## If it blocks a command you want

Run the command yourself in a terminal. The check applies to agents only. If a rule gets in your way often, turn that rule (or the whole check) off with the settings above.
