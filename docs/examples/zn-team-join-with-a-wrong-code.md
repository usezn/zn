# Example: `team join` with a wrong or expired code

`zn-gate team join` connects your computer to your organization with a join token from your admin. When the token is wrong, you get a short message that says what happened and what to do next. This page lists those messages, with the exit code of each, so you can tell them apart. The outputs below come from real runs against the small test server that the zn-gate repository uses for its own tests, with made-up tokens. The messages are written by zn-gate itself, so you see the same words with the real service. See [zn Team](../team.md) for what joining does.

Run `team join` in your own terminal, not through your agent. It needs the vault unlocked (`npx -y zn-gate unlock`); when it is not, the answer is `vault is locked; run ...` and nothing else is checked. The join is then confirmed on the vault's own channel, not in the terminal where you typed the command.

## 1. No token

```bash
npx -y zn-gate team join
```

```text
[zn] No join token given. Your organization admin sends you a token that starts with znj_. Run: zn team join <token> (or `zn team join -` to paste it, or set ZN_TEAM_JOIN_TOKEN). All options: zn team --help
```

Exit code `2`. Nothing was contacted. Use `npx -y zn-gate team join -` and paste the token, so that it stays out of your shell history.

## 2. The link from the invitation email

The email invitation is not a join token. Its link only adds you to the organization on the web. If you paste it, zn says so and does not contact anything:

```text
[zn] That is the link from your invitation email, not a join token. Open the link to accept the invitation at usezn.com/team, then ask your organization admin for a join token (it starts with znj_) and run: zn team join <token>
```

Exit code `2`. See [Invited by email?](../team.md#invited-by-email).

## 3. A token that is not in the right form

A token starts with `znj_` and has a fixed length. A half-copied one is refused:

```text
[zn] invalid join token (expected znj_...). Copy it again from the invitation your administrator sent.
```

Exit code `1`. Copy the whole token again, with no spaces or line breaks.

When you give the token as an argument, zn first prints one note: `a join token given as an argument stays in your shell history and is visible in the process list`. That is advice, not an error. It goes away when you use `team join -` or set `ZN_TEAM_JOIN_TOKEN`.

## 4. Expired, already used or unknown

A token that looks right but that the server does not accept gets one message, whatever the reason: the token expired, it was already used up, or it does not exist (for example, one letter was copied wrong):

```text
[zn] This join token is expired, already used or not valid, so this machine was not connected. Ask your organization admin for a new invitation, then run: zn team join <new token>
```

Exit code `1`. The three cases print the same words: the real runs for an unknown token, an expired one and a used-up one gave identical text. Nothing is changed on your computer, and `npx -y zn-gate team status` still says `Not in a zn organization.` With `ZN_VERBOSE=1` an extra `details:` line shows the HTTP status the server answered (`403` in these runs). What to try: check the token once against the invitation, then ask your admin for a new one. An expired or used-up token cannot be revived, so the next step is always a new invitation.

## 5. The server cannot be reached

```text
[zn] Could not reach the zn server, so this machine was not connected. Check your internet connection and run the same command again: zn team join <token>
```

Exit code `1`. The token was not used up. Check your connection (and any VPN or proxy), then run the same command again.

## 6. A good token

For comparison, a token the server accepts prints the organization and installation, then checks for a policy:

```text
Joined Fake Org (org_aNG9hdV4VLqTpdeq). Installation 61797b1e-8954-4528-b2ef-8d51eeca4540.
[zn] Your admin has not published a policy yet, so no restrictions apply for now. This is expected: zn checks again by itself; to check now run: zn team sync
```

The exit code is `1` here only because this test organization has no policy yet: the join is then pending, and `npx -y zn-gate team sync` finishes it. With a published policy the command exits `0`. See [`team join`](../cli.md#team-join).

## Where to read more

- [zn Team](../team.md)
- [Team quick guide](../team-quick-guide.md)
- [Messages from `zn team`](../troubleshooting.md#messages-from-zn-team)
- [Example: the first day of zn Team](team-first-day.md)
