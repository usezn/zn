# Example: show the vault lock state in your shell prompt

You can put a short label in your shell prompt that says whether the zn-gate vault is open or locked, so you know before you run a command that needs a secret. This page shows a small script for Bash and one for PowerShell. All values are made up. For every vault command, read the [command list](../cli.md#vault-status) and [Keep secrets out of your agent](../secrets.md).

Run everything here in your own terminal. The scripts only read the state: they never unlock, lock or ask for a passphrase.

## What `vault status` prints

```bash
zn-gate vault status
```

There are three states. These outputs come from real runs in a throwaway home folder, which is shown as `~`. Messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`); here it is shortened to `zn-gate`.

```text
Vault: not created yet (run `zn-gate unlock`).
```

```text
Vault: locked (backend passphrase)
Location: ~/.zn/vault
```

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 19:15 (in 8 h) at the latest, zn-gate 1.15.0)
Location: ~/.zn/vault
```

When the running vault is older than the installed zn-gate, the unlocked line has an extra ending. The line still starts with `Vault: unlocked`:

```text
..., outdated: restart with `zn-gate lock`, then `zn-gate unlock`
```

## The exit code does not tell the states apart

`vault status` exits with `0` in all three states, because showing the state is not a failure. It exits with `2` only when you use it wrongly, for example with an extra word. So a prompt script has to read the first words of the first line and not the exit code:

| First line starts with | Meaning | Label in the examples |
|---|---|---|
| `Vault: unlocked` | The vault is open. | `[vault open]` |
| `Vault: locked` | The vault exists and is locked. | `[vault locked]` |
| `Vault: not created yet` | You have not run `unlock` yet. | no label |

## Keep it cheap

A prompt runs on every Enter, so the script must be quick. One run of `zn-gate vault status` starts Node.js. In a test on a Linux machine it took about 70 ms, of which about 20 ms is Node.js starting at all. Two choices keep the prompt from feeling slow:

- Use the installed command (`npm install -g zn-gate`), not `npx`. `npx` does its own package lookup before it starts zn-gate, so it is slower.
- Ask only every 30 seconds and keep the last answer in between. In the same test, 1000 prompts answered from the saved result took 7 ms in total.

The cost is that the label can be out of date for up to 30 seconds after you run `zn-gate lock` or `zn-gate unlock`. If that bothers you, lower the number. If you notice a pause on a slow machine, raise it or remove the label.

## Bash

Put this in `~/.bashrc`:

```bash
_zn_vault_label=""
_zn_vault_at=-30
_zn_vault_refresh() {
  if (( SECONDS - _zn_vault_at < 30 )); then return; fi
  _zn_vault_at=$SECONDS
  case "$(zn-gate vault status 2>/dev/null | head -n 1)" in
    "Vault: unlocked"*) _zn_vault_label="[vault open] " ;;
    "Vault: locked"*) _zn_vault_label="[vault locked] " ;;
    *) _zn_vault_label="" ;;
  esac
}
PROMPT_COMMAND="_zn_vault_refresh${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
PS1='${_zn_vault_label}'"$PS1"
```

`SECONDS` is Bash's own count of seconds since the shell started, so a prompt inside the 30 seconds costs nothing. If `zn-gate` is not installed, nothing is printed, the last case matches and the label stays empty: the prompt is unchanged. With the vault locked, the prompt looks like this:

```text
[vault locked] you@laptop:~$
```

## PowerShell

Put this in your PowerShell profile (the file named by `$PROFILE`):

```powershell
$script:ZnVaultAt = [datetime]::MinValue
$script:ZnVaultLabel = ''
$script:ZnOriginalPrompt = $function:prompt
function prompt {
  if (([datetime]::Now - $script:ZnVaultAt).TotalSeconds -ge 30) {
    $script:ZnVaultAt = [datetime]::Now
    $first = (& zn.cmd vault status 2>$null | Select-Object -First 1)
    if ($first -like 'Vault: unlocked*') { $script:ZnVaultLabel = '[vault open] ' }
    elseif ($first -like 'Vault: locked*') { $script:ZnVaultLabel = '[vault locked] ' }
    else { $script:ZnVaultLabel = '' }
  }
  $script:ZnVaultLabel + (& $script:ZnOriginalPrompt)
}
```

It calls `zn.cmd`, the form that works when PowerShell says "running scripts is disabled on this system" (see [troubleshooting](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows)). The label comes from the same first line as in Bash.

## Related

- [Example: vault verify, forget and purge](vault-verify-and-forget.md): the other vault commands.
- [Examples](README.md): the list of all example pages.
