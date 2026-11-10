# Policy block categories

When a hook stops one of your agent's actions, the message says why. This page
lists the families of reasons zn-gate uses, so you can tell which kind of
block you are looking at. It names the categories only. It contains no working
examples of blocked commands.

For one real block message, read [block-message-anatomy.md](block-message-anatomy.md).
For the steps to take after a block, read
[why-was-this-blocked.md](../why-was-this-blocked.md).

The text below was checked against the code at `origin/next`. Line numbers
point to that version and may move later.

## 1. Destructive commands

These come from the destructive-command check. A block reads
`zn blocked this: <reason> (rule: destructive:<rule>)` (`lib/destructive.js:545`).

| Rule id | Plain reason in the message | On by default |
| --- | --- | --- |
| `rm_root_home` | it deletes the home folder, the filesystem root or a system folder, recursively | yes |
| `disk_overwrite` | it writes to or formats a disk device | yes |
| `pipe_to_shell` | it downloads a script and runs it without anyone reading it first | no |
| `perm_root` | it changes permissions or owners across the whole filesystem or a system folder | no |
| `fork_bomb` | it is a fork bomb, which freezes the machine | no |
| `rc_download` | it writes downloaded content into a shell startup file, which runs in every new terminal | no |

The reasons are copied from `lib/destructive.js:30-37`. The two rules marked
"yes" are the defaults (`lib/destructive.js:550`); the other four are opt-in
(`lib/destructive.js:549`).

A command with more parts than the check can handle is refused as well, with
the reason "it has more commands than can be checked, so it is refused rather
than guessed at" (`lib/destructive.js`, `OVERFLOW_REASON`).

## 2. The secret vault and secret files

- **The vault folder.** Agents may not read or change it. The message says
  that the folder is where zn keeps your secrets (`lib/hooks/policy.js:1695`).
- **Secret files.** Commands that would read a file zn treats as a secret file
  are blocked under the rule names `secret-file:dotenv` and
  `secret-file:credential` (`lib/hooks/policy.js`, around lines 796 and 890).
- **Secret values inside a command.** A placeholder for a vault secret that
  appears in a `VAR=...` assignment before a command cannot be filled in, so the
  command is blocked (`lib/hooks/policy.js:1488`). A PowerShell command that
  would need a pipeline, a variable or a script block to put a secret in place
  is blocked too (`lib/hooks/policy.js:1580`).

## 3. Commands only the user may run

Some zn commands change protection, the vault or the cloud settings. An agent
may not run them. The message says the choice belongs to the user and names the
command, for example "which is the user's decision" (`lib/hooks/policy.js:3339-3385`).
The covered commands are:

- `audit --approve`, which accepts the current MCP servers, hooks and permissions
  of a project (`lib/hooks/policy.js:3357`);
- `pins approve`, which accepts changed MCP tools (`lib/hooks/policy.js:3361`);
- `init`, which turns protection on for coding agents (`lib/hooks/policy.js:3364`);
- turning protection on or off for one agent (`lib/hooks/policy.js:3368`);
- `vault reset` and `vault purge`, which replace or delete the vault
  (`lib/hooks/policy.js:3371`, `3374`);
- locking or unlocking the vault (`lib/hooks/policy.js:3377`);
- turning the optional cloud check on or off (`lib/hooks/policy.js:3380`);
- `stats share on` (`lib/hooks/policy.js:3383`);
- reading or changing secret values (`lib/hooks/policy.js:3385`).

## 4. Agent instruction files and zn's own setup

- **Files an agent reads as standing instructions.** A write to one of them is
  blocked, and the message says that zn is set to block that and the user must
  make the change (`lib/hooks/policy.js:1009-1017`).
- **zn and its hooks.** An agent may not change how zn and its hooks run
  (`lib/hooks/policy.js:2405`).

## 5. Commands zn cannot check in full

zn would rather stop than guess. These blocks have their own messages, and the
next step in each is to run the work as several shorter commands, or to ask the
user (`lib/hooks/policy.js:1705`, `1707`, `1743`).

- **Too long.** A command over 100 KB is blocked under the rule
  `size:command-too-long`. Unchecked, it could read a secret or a protected file
  (`lib/hooks/policy.js:1680`, `1700`).
- **Too many chained commands.** The command chains more commands than zn checks
  at once (`lib/hooks/policy.js:1705`).
- **Too many paths for the time budget.** The check has a time budget of 3
  seconds (`lib/hooks/policy.js:1704`). A command with too many paths to finish
  inside it is blocked (`lib/hooks/policy.js:1707`).
- **Nested shell code.** Shell code nested more than 3 levels deep (for example
  a shell that starts a shell that starts a shell) is blocked
  (`lib/hooks/policy.js:1742-1743`).
- **Windows roots and network shares.** A command that reads a file through a
  Windows root or a network share, which zn cannot check, is blocked
  (`lib/hooks/policy.js:3305`).
- **File patches sent as a shell command.** A patch of a file that zn cannot
  check file by file, sent through the shell, is blocked
  (`lib/hooks/policy.js:1733-1737`).

## Which category am I in?

- The message names a rule id starting with `destructive:` → section 1.
- It mentions the secret vault or a secret file → section 2.
- It says the choice is the user's decision → section 3.
- It names an instruction file or zn's own hooks → section 4.
- It says "too long", "too many", "too slow", "nests" or "cannot check" → section 5.

If none of these fits, read the output of `zn why` for the command, as described
in [zn-why-allow-command.md](zn-why-allow-command.md).
