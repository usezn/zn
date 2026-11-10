# Example: a healthy `zn-gate doctor` run, line by line

`doctor` is another name for `check`. This page walks through a run where every agent set up on the machine is protected, so you know what a good result looks like. The explanations come from the code of `zn-gate` 1.15.0. The output below is a real run on a test machine: the home folder was a throwaway one, Claude Code was set up with `zn hooks install claude-code`, and the Claude Code program itself was not installed, which is why one line says `version: not found`. Your lines will differ in the agents, the version and the counts.

```text

zn-gate check: does zn stop your coding agent from reading a secret?

zn made a test folder with a fake key in a .env file and an ordinary file next to it, then asked
each agent's zn hook whether the agent may read them. This is what happened:

  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."
     version: not found
  -  Codex CLI    not found on this machine
  -  Cursor       not found on this machine
  -  OpenCode     not found on this machine
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine

Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
If your agent needs a value from .env, keep it in zn's vault instead: `zn env shadow .env`.
More: https://usezn.com/docs/check

The test folder was deleted.

Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.
Hooks: 6 OK, 0 stale, 0 broken. Run zn-gate check --hooks for details.

```

Run it with `npx -y zn-gate doctor` or `npx -y zn-gate check`. Run it in your own terminal, not through your AI agent. The command makes no network call and changes no setting; it writes a test folder and deletes it at the end.

## The title and the test folder

- `zn-gate check: does zn stop your coding agent from reading a secret?` is the first line of the report (`lib/check.js:1466`).
- The next two lines say what the check does: it makes a folder with a `.env` file that holds a fake key and an ordinary file, then asks each agent's zn hook whether the agent may read each of them (`lib/check.js:1467-1468`). The `.env` file is written with the fake key from `FAKE_LINE`, and the folder is removed in a `finally` block, so it is removed even when a check fails (`lib/check.js:1456`).

## The `OK` line

`OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:`

- `OK` is printed for an agent whose state is `protected` (`lib/check.js:1498`). An agent is `protected` only when zn's hook denies the `.env` read and allows the ordinary file (`lib/check.js:1003`). If either part fails, the agent gets a problem and the line starts with `X` instead (`lib/check.js:1334`).
- The quoted text under it is the message the hook gives the agent when it blocks the read (`lib/check.js:1002`, printed at `lib/check.js:1499`). It is the same text your agent sees in a real block, so this line shows what the agent is told.
- `(rule: secret-file:dotenv)` inside that message is the rule that fired. Rule names are explained in [why was this blocked](../why-was-this-blocked.md).

## `version: not found`

`     version: not found` is printed under an agent's line (`lib/check.js:1473`). It comes from `versionLine` in `lib/agents/versions.js:66-73`. The text depends on what the check found:

- `version: not found`, with `(tested with <version>)` added when zn has a tested version for that agent (`lib/agents/versions.js:68`): the agent program did not answer a version request. This run had no `claude` program on the PATH.
- `version <found>, the version zn was last tested with`: the installed version matches the tested one (`versions.js:69`).
- `version <found>, newer than ...` or `older than ...`: the version differs from the tested one, with what to do (`versions.js:70-71`).

A `version: not found` line does not make the agent fail. The protection test is separate, and the agent is still `OK`.

## The lines for agents that are not on the machine

`-  Codex CLI    not found on this machine` means the check found no trace of that agent for your user, so there is nothing to protect and nothing to do (`lib/check.js:1476`). These lines do not count as failures. The exit code only looks at agents that are set up (see the last section).

## The summary

- `Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.` is printed when every agent that is set up is protected (`lib/check.js:1513`). "Nothing was sent anywhere" means the check makes no network call.
- `If your agent needs a value from .env, keep it in zn's vault instead: zn env shadow .env.` is a reminder for the normal case: a real `.env` with values in it should move to the vault (`lib/check.js:1515`). See [secrets](../secrets.md).
- `More: https://usezn.com/docs/check` links to the full page (`lib/check.js:1516`).
- `The test folder was deleted.` is printed when the test folder is gone (`lib/check.js:1522`). The other text, `The test folder could not be deleted; it holds only the fake key.`, appears only when the folder is still there.

## The lines after the report

- `Decision time per tool call: no data yet. ...` comes from the latency report (`lib/stats.js:252`). It shows `p50` and `p95` times once zn has measured some real tool calls on this machine (`lib/stats.js:254`). It is turned off with `ZN_STATS=off` (`lib/stats.js:250`), and the test read itself is never counted (`bin/cli.js:1420`).
- `Hooks: 6 OK, 0 stale, 0 broken. Run zn-gate check --hooks for details.` is one line from the hook list (`lib/hooks-list.js:214`), printed last (`bin/cli.js:1446-1447`). The first number is how many zn hooks are listed as OK. `stale` means a hook that needs refreshing, for example one written by an older zn-gate (`lib/hooks-list.js:203`). `broken` means a hook zn cannot check, for example because the agent's settings file is not valid JSON or the entry is not in the form zn writes (`lib/hooks-list.js:58`, `:64`). A healthy machine shows `0 stale, 0 broken`. The number of hooks depends on how many agents you set up.

## The exit code

The run ends with exit code `0`. The rule is in `exitCodeOf` (`lib/check.js:1527-1536`): the code is `0` only when at least one agent is set up and no set-up agent is `not-protected`. Agents that are not on the machine are skipped. A run where no agent is set up exits with `1`, and so does a run where one set-up agent is not protected.

## The same result as JSON

`npx -y zn-gate check --json` prints one object with the same facts. In this run it shows `"exit_code": 0`, `"protected": true`, and for Claude Code `"state": "protected"` with the same message. Every other agent has `"state": "not-found"`. The field list is in [Machine-readable output](../check.md#machine-readable-output). The JSON has `"test_folder_removed": true` in place of the test-folder line (`lib/check.js:1578`), and it has no hook summary line and no secret value.

## What to do next

- If a line starts with `X` (not protected) or `-` for an agent you use, read [What each NOT protected line means](../check.md#what-each-not-protected-line-means) and the sample in [reading a check output](check-output-explained.md).
- To see the hooks themselves, run `npx -y zn-gate check --hooks`.
- To see what zn blocked, run `zn why`. See [why was this blocked](../why-was-this-blocked.md).

## More

- [Check that it works](../check.md): the full page.
- [Example: reading a check output line by line](check-output-explained.md): a sample with one protected agent and one that is not set up.
- [Checklist: what to run and paste before asking for help](doctor-before-asking-for-help.md)
