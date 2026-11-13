# Example: team onboarding checklist

A checklist for the first day of a new member of a zn Team organization: one line per step, with the command and what you should see. Run every command in your own terminal, not through an AI agent. Why each step works the way it does is in [zn Team on a developer machine](../team.md) and the [quick guide for a team lead](../team-quick-guide.md). The join token and the organization name below are made up.

## Before you start

- [ ] Ask your team lead for a join token. It starts with `znj_`. The lead also tells you the organization name, so you can compare it in step 4.
- [ ] Install zn-gate, which puts the `zn` command on your PATH: `npm install -g zn-gate`. Expected: `zn --help` prints the list of commands.

## Steps

- [ ] 1. Unlock the vault: `zn unlock`. Expected: a line starting with `Vault unlocked:`. The first run creates the vault. If you are told the vault is locked in a later step, run this again.
- [ ] 2. Join with the token: `zn team join -`, then paste the token and press Enter. It stays out of your shell history.
- [ ] 3. Answer the vault's prompt, not the terminal. The vault first asks whether zn-gate may send the token to the zn service to look up the organization. Then a dialog shows the organization name, who invited you, the server and the last characters of the token.
- [ ] 4. Compare the dialog with what your lead sent. If it matches, approve. If you did not start the command yourself, choose Deny.
- [ ] 5. Read the end of the join output. Expected: `Joined Example Org (...). Installation ...`, then `Policy: version N`. The command exits `0`.
- [ ] 6. Check the policy is active: `zn team status`. Expected: an `Organization:` line with your organization, and a `Policy:` line that reads `version N, valid until <date>`. The `Policy:` line must not say `PENDING`, `EXPIRED` or `STRICT MODE`.
- [ ] 7. Check the rest of the status. Expected: `Last sync:    ok, <time>` and an `Audit upload:` line. `zn team status` never shows your install token.
- [ ] 8. Optional: see which rules are in force: `zn team status --rules`. It reads the copy saved on this machine and makes no network call.

## If a step fails

- [ ] `zn team join` says no join token was given: it exited `2`. Check that you pasted a token that starts with `znj_`, or set `ZN_TEAM_JOIN_TOKEN` and run `zn team join`.
- [ ] The command asks you to unlock: run `zn unlock`, then repeat the step.
- [ ] `zn team join` says your admin has not published a policy yet: this is expected, and no restrictions apply for now. The join stays pending and the command exits `1`. zn checks again by itself; run `zn team sync` to check now.
- [ ] `zn team join` says the join is not finished (offline, or a policy that was refused): the machine is registered, but no valid policy applies yet. Fix the cause it names, then run `zn team sync`. It exits `0` only when a valid policy is applied and nothing failed to upload.
- [ ] `zn team status` shows `Policy:` as `none received yet (PENDING ...)`: run `zn team sync`. If it still fails, ask your lead whether a policy has been published.
- [ ] `zn team sync` says it could not reach the zn server: check your internet connection and run it again. Nothing was changed.
- [ ] `zn team status` shows `REMOVED FROM ORG`: an admin removed this machine. Ask your lead for a new token, run `zn team leave` and join again.
- [ ] You pasted the token as an argument: zn prints a note that it stays in your shell history. Use `zn team join -` next time.
- [ ] Anything else: add `ZN_VERBOSE=1` to the command to see the technical cause, and send that to your lead.

## Leave this machine

- [ ] `zn team leave`. Expected: `Left <organization>. The organization policy no longer applies on this machine.`

## More

See also: [`team` in the command reference](../cli.md#team) and [Offline, expiry and removal](../team.md#offline-expiry-and-removal).
