# Example: run `reach` before and after you rotate a key

You rotated a key that your coding agent could read. This page uses [`zn-gate reach`](../reach.md) to check that the old copies are gone from where an agent looks, and to see what `reach` cannot tell you. It uses a fake GitHub token, a throwaway home folder and a throwaway project. The output comes from real runs. The commands are written as `zn`; if `zn` is not on your PATH, write `npx -y zn-gate` in its place.

`reach` is read only, sends nothing and never prints a value. It does not call the service that issued the key, so it cannot tell a live key from a rotated one. It shows where a secret sits. Rotating the key at the place that issued it is a step you do yourself, outside zn-gate.

In the outputs below, the seven agents that are listed as `not found on this machine` are left out. Everything else is as printed.

## 1. Before: where does the old key sit?

The project has a `.env` with the old token, and an agent kept the same token in a session file:

```text
GITHUB_TOKEN=ghp_EXAMPLEOLDTOKEN0123456789abcdefghijk
PORT=3000
```

Check the folder, and keep the counts for the next run with `--remember`:

```text
$ zn reach . --remember
zn-gate reach: what can the coding agents on this machine reach?
Read: agent settings in your home folder and this folder, .env files here, names of environment variables. Nothing was sent anywhere.

AGENTS
  Claude Code  not protected
  ...
  HIGH   Claude Code is on this machine and zn does not protect it
         It can read any file and run any command you allow.
         Fix: npx -y zn-gate init

WHAT THEY CAN REACH (secrets and credential files an agent could read; names only, never values)
  HIGH   .env in this folder has 1 secret (GITHUB_TOKEN)
         Claude Code can read them today.
         Fix: npx -y zn-gate env shadow .env

NEXT: fix the high ones
  1. npx -y zn-gate init
  2. npx -y zn-gate env shadow .env

2 high, 0 medium, 0 low.
```

Then the session histories, which are in your home folder and not in the project:

```text
$ zn reach --history
zn-gate reach --history: did your coding agents keep a secret of yours in their session history?
Read: the local history files of your agents. Nothing was sent anywhere, nothing was changed, and no value is shown.

  Claude Code  1 file, 0.0 MB scanned
  Codex CLI    no history found
  ...

CLAUDE CODE
  ~/.claude/projects/-home-me-app/3f2a.jsonl
    1 x GITHUB_TOKEN
    Do this: Rotate this GitHub token in your GitHub settings, then delete this session file if you do not need it.

1 secret in 1 file.

A key listed here may already be rotated. Check before you rotate.
zn-gate cannot see what was already sent to your model provider.
```

The `...` lines stand for the agents that are not scanned, as in [Reading a reach history report](reading-a-reach-history-report.md). So the old key sits in two places: the `.env` file and one session file.

## 2. Rotate, then keep the new value out of the file

Create the new token where it was issued, and revoke the old one there. Then put the new value where the old one was. Here the new token is written into the `.env` file for a moment, and `env shadow` moves it into the vault. Run it in your own terminal with the vault unlocked (`zn unlock`):

```text
$ zn env shadow .env
Shadowed 1 value(s) in .env. The file now holds only markers; the values are in the local vault.
Encrypted copy of the original: ENVBAK_X4BA2177ED202611081320 (restore with: zn env unshadow .env --backup ENVBAK_X4BA2177ED202611081320)
Next: allow the commands that need them, e.g. zn secret allow GITHUB_TOKEN --command "npm run dev"
Run your app with the real values: zn run --secrets GITHUB_TOKEN -- <command>
```

```text
GITHUB_TOKEN=__ZN_GITHUB_TOKEN__
PORT=3000
```

The encrypted copy holds the new value, not the old one, because the old one was already replaced. See [`env shadow`](../cli.md#env-shadow).

## 3. After: check the folder again

```text
$ zn reach . --remember
zn-gate reach: what can the coding agents on this machine reach?
Read: agent settings in your home folder and this folder, .env files here, names of environment variables. Nothing was sent anywhere.

AGENTS
  Claude Code  not protected
  ...
  HIGH   Claude Code is on this machine and zn does not protect it
         It can read any file and run any command you allow.
         Fix: npx -y zn-gate init

NEXT: fix the high ones
  1. npx -y zn-gate init

1 high, 0 medium, 0 low (last time, 2026-11-08: 2 high, 0 medium, 0 low).
```

The `WHAT THEY CAN REACH` section is gone: the `.env` holds only a marker, and `reach` does not count markers. The last line compares with the run in step 1 because of `--remember`. The remaining high finding is the agent itself. In this throwaway folder zn is not set up for Claude Code, so `init` is still the next step. It is not about the key. See [--remember](../reach.md#--remember).

## 4. After: check the histories

```text
$ zn reach --history
...
CLAUDE CODE
  ~/.claude/projects/-home-me-app/3f2a.jsonl
    1 x GITHUB_TOKEN
    Do this: Rotate this GitHub token in your GitHub settings, then delete this session file if you do not need it.

1 secret in 1 file.
...
```

The old token is still listed. `reach` cannot see that it was rotated, and shadowing the `.env` does not touch a file that an agent saved earlier. Once the key is rotated, the copy in that file is a dead key. Delete the session file if you do not need it (here, with `rm`), then run the check again:

```text
$ zn reach --history
...
  Claude Code  0 files, 0.0 MB scanned
  Codex CLI    no history found
  ...

No secret found in the history files that were scanned.

A key listed here may already be rotated. Check before you rotate.
zn-gate cannot see what was already sent to your model provider.
```

## What to check

- `.env` finding gone from `WHAT THEY CAN REACH`: the file holds markers, not values.
- `--history` lists nothing for the old key, or only files you chose to keep because the key is rotated.
- A history finding after a rotation does not mean the new key leaked. It means a file still holds a value of that type. Check the date of the file, and what you rotated.
- `reach` does not read your git history and does not check whether a key works. If the old key was ever committed or shared, rotating it at the issuer is what makes it harmless.
- `reach` cannot see what was already sent to your model provider. Rotating is what covers that.
- The agent line stays high until zn is set up for that agent: run `zn init`, as the `NEXT` block says.

## See also

- [`zn-gate reach`](../reach.md), with [History: did your agents keep a secret of yours?](../reach.md#history-did-your-agents-keep-a-secret-of-yours)
- [Reading a reach history report](reading-a-reach-history-report.md)
- [Example: a `.env` file round trip through the vault](env-file-round-trip.md)
- [Example: write the reach report to a file in CI](reach-report-file.md)
