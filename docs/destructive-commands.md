# Destructive commands (optional check)

zn-gate can refuse a small set of shell commands that wipe a machine or run a download unread. The check is **off by default**. Nothing changes until you turn it on.

It is a guardrail against a model's mistake or a bad suggestion, not a sandbox. It reads the text of one command and blocks it only when the command has one of the shapes below.

## Turn it on

For the agent hooks (Claude Code, Codex CLI, Cursor, OpenCode and the others `zn hooks install` supports), set this in `~/.zn/config.json`:

```json
{"hooks": {"blockDestructiveCommands": true}}
```

`ZN_BLOCK_DESTRUCTIVE=1` in the environment also turns it on. The environment variable can only turn the check on, never off, because the project an agent works in can set environment variables. The agent's file tools cannot write to `~/.zn`, so only you can change the setting.

When it is on, the hooks apply it to the shell tools (Bash, PowerShell and monitors). A blocked command is not run, and the agent is told why and to ask you instead.

In your own code, call the function directly. Calling it is the opt-in: it always applies the check.

- Node.js: `checkCommand(command)` from `zn-gate/lib/client`
- Python: `check_command(command)` from `zn_gate`

Both return the same result as `evaluate`, with a rule such as `destructive:rm_root_home`. See the [API reference](api-reference.md).

## What it blocks

| Rule | Blocks | Examples |
| --- | --- | --- |
| `rm_root_home` | Recursive delete of the home folder, the filesystem root, a top-level system folder or a drive root. Also `find` with `-delete` or `-exec rm` on those paths and no test such as `-name`. | `rm -rf ~`, `rm -rf $HOME/*`, `rm -rf /`, `rm -rf /usr`, `rm -rf /home/alice`, `Remove-Item -Recurse -Force $env:USERPROFILE`, `rd /s /q C:\` |
| `pipe_to_shell` | A download that is run as a script without being read. | `curl https://example.com/install.sh \| sh`, `wget -qO- ... \| sudo bash`, `sh -c "$(curl ...)"`, `bash <(curl ...)`, `iwr ... \| iex` |
| `disk_overwrite` | `dd` with `of=` a block device, `mkfs`, `mkswap`, `wipefs`, `shred` or `blkdiscard` on one, a redirect into one, PowerShell `Format-Volume` and `Clear-Disk`. | `dd if=/dev/zero of=/dev/sda`, `mkfs.ext4 /dev/nvme0n1p2`, `cat /dev/zero > /dev/sda` |
| `perm_root` | `chmod -R`, `chown -R` or `chgrp -R` on the filesystem root or a top-level system folder; `chmod -R` with a world-writable mode on the home folder. | `chmod -R 777 /`, `chown -R nobody /usr`, `chmod -R 777 ~` |
| `fork_bomb` | The classic shell fork bomb, under any function name. | `:(){ :\|:& };:` |
| `rc_download` | A download written into a shell startup file (`.bashrc`, `.zshrc`, `.profile`, `/etc/profile`, fish `config.fish`, PowerShell `$PROFILE`). | `curl -o ~/.bashrc https://example.com/rc`, `curl ... \| tee -a ~/.zshrc` |

"Top-level system folder" means `/bin`, `/boot`, `/dev`, `/etc`, `/home`, `/lib`, `/opt`, `/root`, `/sbin`, `/srv`, `/sys`, `/usr`, `/var`, and on macOS `/Users`, `/System`, `/Library`, `/Applications`. A deeper path such as `/var/lib/apt/lists` or `/usr/local/lib/node_modules/x` is not blocked.

The command is split the way the rest of zn-gate's hook policy splits it, so quotes, `&&`, `;`, pipes, `sudo`, `env`, `nohup` and similar wrappers are understood. The code of `sh -c`, `bash -lc`, `eval`, `pwsh -Command` and `cmd /c` is checked too, up to three levels deep. Text that only mentions a command inside quotes (`echo "rm -rf ~"`, a commit message) is not blocked.

## What it does not do

The check reads command text only. These are **not** covered, and the check lets them through:

- A path the command builds at run time: `rm -rf "$DIR"` with an empty `DIR`, `rm -rf *` in an unknown folder, or a target that comes from a pipe (`echo ~ | xargs rm -rf`).
- A script saved first and run later (`curl -o x.sh ... && sh x.sh`), or a download piped into an interpreter that is not a shell (`curl ... | python3`).
- Other tools and languages (`rsync --delete`, `git clean`, `python -c "shutil.rmtree(...)"`), and paths below the top level (`rm -rf /usr/local`).
- Commands that run inside a container (`docker run ... rm -rf /`) or on another machine (`ssh host "rm -rf /"`).
- Anything an agent does by writing a file and then running it.

For those, use a sandbox, a container or your agent's own permission prompts. This check adds a cheap last barrier for the most common catastrophic mistakes.

## How well it works

The test corpus has about 1,000 ordinary developer commands (builds, git, package managers, containers, `rm -rf node_modules dist build target .venv`, `curl -o`, `curl | jq`, edits to `.bashrc`, and many that sit close to the blocked shapes) and about 550 commands with the blocked shapes, written from templates with varied flags, targets and fictitious hosts. On that corpus there are no false positives and no misses; the corpus is written by the same people who wrote the rules, so read it as a regression test, not as an error rate on all real commands. Run `node bench/destructive_policy.js` in the repository to see the numbers, and `--docs` to also check the shell lines of the repository's documentation.

Cost: about 5 microseconds per command for the check itself, and a few microseconds more for a hook decision, which takes about 160 microseconds without it. When the check is off, no code of it runs.

## If it blocks a command you want

Run the command yourself in a terminal. The check applies to agents only.
