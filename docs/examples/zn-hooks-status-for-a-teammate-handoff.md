# Checklist: before you hand a machine over to a teammate

Use this when a computer that has zn-gate on it goes to another person, for example a laptop for a new colleague, or a shared machine that someone else takes over. Run every command in your own terminal, not through an agent. The reference for each command is in the [CLI page](../cli.md); the removal steps are in [Remove zn-gate](../uninstall.md).

The output below comes from real runs on a throwaway home folder, shown as `~`, with Codex CLI as the agent. Your lines will name your own agents and files.

## 1. See what is set up

- [ ] Read the hooks: `zn-gate check --hooks`. It lists every installed hook and says OK, stale or broken. It only reads files; nothing is run, changed or sent.

  ```text
  Codex CLI (user): ~/.codex/hooks.json
    OK     PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
    ...
  7 OK, 0 stale, 0 broken.
  ```

  Seven hook lines were printed and six are left out here. The exit code is 0 when every hook is OK.

- [ ] Keep a record of the state: `zn-gate check --json > check.json`. It is the same check as one JSON object, with no secret values and your home folder shown as `~`. In the run, the keys were `schema`, `zn_gate_version`, `node_version`, `exit_code`, `protected`, `agents`, `warnings`, `project_rules_errors` and `test_folder_removed`, and `protected` was `true`. The teammate can compare it with their own run later.

- [ ] Look at the vault: `zn-gate vault status`.

  ```text
  Vault: unlocked (backend passphrase, locks after 30 min idle, or at 23:23 (in 8 h) at the latest, zn-gate 1.15.0)
  Location: ~/.zn/vault
  ```

- [ ] See which secrets are in it: `zn-gate secret list`. It needs the vault unlocked and shows names and policy, never values.

  ```text
    DEMO_TOKEN                    proxy
  ```

## 2. Do not hand these over

The `.zn` folder holds what belongs to you, not to the machine. Among the files it held in the run:

```text
~/.zn/vault/identity.age
~/.zn/vault/keychain.json
~/.zn/vault/secrets.age
~/.zn/audit.jsonl
~/.zn/evidence.jsonl
~/.zn/hooks/zn-hook-codex.sh
```

- The vault: `vault/` holds your secrets, encrypted, and the key that opens them. Do not copy it to the teammate or leave it for them. They store their own values.
- The vault audit log, `audit.jsonl`, which records what the vault did on your behalf.
- The decision log, `evidence.jsonl`, which records what zn-gate allowed or blocked for you.
- A cloud key, if you ran `zn-gate connect`. Run `zn-gate disconnect`: it removes the saved key from this computer and asks whether to revoke it on usezn.com too. On a machine that was never connected it printed `Not connected. Nothing to remove.`
- Membership of a zn Team organization, if you joined one. `zn-gate team status` says it (`Not in a zn organization.` in the run). If it names an organization, run `zn-gate team leave`.
- `.env` files that hold markers such as `__ZN_API_KEY__`. The real values are in your vault and `uninstall` does not edit these files. Put them back first with `zn-gate env unshadow FILE --backup NAME` if the teammate needs them in the file, or tell the teammate to store their own values.

[Files and folders](../files-and-folders.md) lists every file zn-gate writes and the command that removes it.

## 3. Clean the machine

- [ ] Lock the vault: `zn-gate lock`. An unlocked vault is kept, not deleted.
- [ ] Preview the removal: `zn-gate uninstall --dry-run`. It prints the plan and changes nothing:

  ```text
  Will be removed:
    Codex CLI
      - zn's hooks for your user (and its "secrets" MCP server, if listed): ~/.codex/hooks.json
  Asked separately at the end (default no):
    The vault in ~/.zn: your stored secrets. Deleting it cannot be undone.
  ```

- [ ] Run it for real: `zn-gate uninstall`. Answer yes to remove the hooks. To hand the machine over without your vault, answer yes to the second question as well, and only after the `.env` values are back if you need them. The vault is deleted for good.
- [ ] If you used `--project` in other folders, run `zn-gate uninstall` from each of them: it looks at your user settings and at the folder you are in.

## 4. If the teammate keeps zn-gate

Let them set it up themselves, with their own vault: `zn-gate init`, and `zn-gate hooks install <agent>` for each agent they use. They run the checks of step 1 on their own account, and `zn-gate check` must say that the agent is protected.

## Related

- [Remove zn-gate](../uninstall.md)
- [Check the hooks after an agent update](hooks-status-after-agent-update.md)
- [Moving zn-gate to a new computer](moving-to-a-new-computer.md)
- [Safe first day with a new agent](safe-first-day-with-a-new-agent.md)
