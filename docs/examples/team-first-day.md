# Example: a developer's first day on zn Team

A short story in two roles: the lead who sets zn Team up, and one developer. Everything here is documented in the [quick guide for a team lead](../team-quick-guide.md) and [zn Team on a developer machine](../team.md), and each step links there. The organization, the token and the other values are made up; `api.usezn.com` is the real zn service, the host zn-gate talks to.

Run the commands yourself, in your own terminal.

## 1. The lead sends the invitation

The lead is the organization admin. They give the developer a join token (`znj_...`), here `znj_EXAMPLE_NOT_A_REAL_TOKEN`, and tell the developer what the vault dialog will show, so they can compare it: the organization name (here Example Org), who invited them, the server and the last characters of the token. Read more in [Roles in a team](../team.md#roles-in-a-team).

## 2. The developer joins

The vault must be unlocked first:

```bash
zn unlock
zn team join -
# paste the join token and press Enter (it stays out of your shell history)
```

`zn team join -` reads the token from one line of standard input, so it stays out of your shell history. You can also set `ZN_TEAM_JOIN_TOKEN` and run `zn team join`, or pass the token as an argument; an argument wins over the variable, and zn then warns that a token on the command line stays in your shell history and in the process list.

Nothing is confirmed in this terminal. Joining is confirmed on the vault's own channel (the terminal of `zn unlock --foreground`, or a system dialog). An AI agent can type in your terminal; it cannot answer that dialog. First the vault asks whether zn-gate may send the token to `api.usezn.com` to look up which organization it is for. Then the dialog shows the organization name, who invited you, the server and the last characters of the token. Compare them with what the lead sent, and choose Deny if you did not start the command yourself.

The join counts as done only once the organization's first valid policy has been downloaded and applied. If that cannot happen yet (the machine is offline, or the lead has not published a policy so far), the command says so, `zn team status` shows the join as pending, and `zn team sync` finishes it.

Read more in [`team join` in the command reference](../cli.md#team-join) and [What each developer does](../team-quick-guide.md#what-each-developer-does).

## 3. The developer checks the status

```bash
zn team status
```

Shows the organization, the policy version and its expiry, and the state of the audit upload. It never shows the install token. Read more in [`team status` in the command reference](../cli.md#team-status).

## 4. The developer syncs

```bash
zn team sync
```

Downloads the policy and uploads the pending audit records now. It exits `0` only when a valid policy is applied and no upload failed; when it cannot (offline, no policy published yet, a refused policy, a removed machine, a failed upload), it exits `1` and says why. This also happens on its own while the vault is unlocked: a few seconds after `zn unlock`, then every 15 minutes. Read more in [Commands](../team.md#commands).

## 5. What happens on `zn team leave`

```bash
zn team leave
```

Disconnects this machine and asks the server to revoke the installation. The organization's policy stops applying here at once. If the server cannot be asked (offline, a server error, a rate limit), the machine still leaves at once, the command exits `0`, and it says that the server was not told yet: zn-gate keeps retrying (on `zn team sync` and `zn team leave`, and every 15 minutes while the vault is unlocked) for up to 30 days, and `zn team status` shows the pending revocation until the server confirms. Read more in [Leaving](../team.md#leaving).

## More

- What zn-gate sends to the server: [What is sent](../team.md#what-is-sent).
- No network, an expired policy, a removed machine: [Offline, expiry and removal](../team.md#offline-expiry-and-removal).
- Every option and exit code: [`team` in the command reference](../cli.md#team).
