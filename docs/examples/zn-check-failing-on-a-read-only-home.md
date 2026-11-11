# Example: `zn-gate check` when the home folder is read-only

If your account cannot write to your home folder, or to the `.zn` folder in it, `zn-gate check` still runs and prints its report. It adds one line on the error output, and nothing else changes. This example comes from a test on a Linux account with no coding agent installed. It used a throwaway home folder with read permission only. The paths below are made up.

## Run the check with a read-only home

```sh
HOME=/home/you/zn-test-home zn-gate check
```

The report on the standard output is the same as on a writable home:

```text
zn-gate check: does zn stop your coding agent from reading a secret?

zn made a test folder with a fake key in a .env file and an ordinary file next to it, then asked
each agent's zn hook whether the agent may read them. This is what happened:

  -  Claude Code  not found on this machine
  -  Codex CLI    not found on this machine
  -  Cursor       not found on this machine
  -  OpenCode     not found on this machine
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine

No supported coding agent was found on this machine (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app), so there is nothing to check.
Install one, then run `npx -y zn-gate init`. Other editors: https://usezn.com/docs/install

The test folder was deleted.

Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.
```

With a writable home, the standard output is the same text.

## The line on the error output

The only difference is one line on the error output:

```text
zn-gate: cannot write to the evidence log /home/you/zn-test-home/.zn/evidence.jsonl (EACCES). Events are not being recorded; the log is left as it is.
```

- `evidence.jsonl` is the local decision log. zn keeps it in the `.zn` folder of your home folder. The path in the line is the one zn tried to write.
- `EACCES` is the system's code for "your account is not allowed to write here".
- The check does not stop. The test folder was still made and deleted, and the report is complete.

The test folder is made in the system temporary folder (`TMPDIR` on Linux and macOS), not in your home folder. In the runs on this page, the only write under the home folder that failed was the decision log.

## The `--json` output

```sh
HOME=/home/you/zn-test-home zn-gate check --json
```

The standard output is one JSON object, the same as on a writable home. The line above still goes to the error output, not into the JSON:

```json
{
  "schema": 1,
  "zn_gate_version": "...",
  "node_version": "...",
  "exit_code": 1,
  "protected": false,
  "agents": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "state": "not-found",
      "protected": false,
      "checked": true
    }
  ],
  "warnings": [],
  "project_rules_errors": [],
  "test_folder_removed": true
}
```

The list has one entry for each agent, and it is shortened here. `"warnings": []` stays empty because the evidence line is not a warning in the JSON. A script that reads the JSON is not affected by this line.

## The exit code

In this test the exit code is `1`, both on a read-only home and on a writable one. The reason is that no agent was set up, not the read-only home. The check exits with `0` only when every agent that is set up for your user is protected (see the [check page](../check.md)). This example did not test a machine with an agent set up, so it does not say what the exit code is there.

## How to fix it

1. Read the path after `evidence log` in the line. It is the folder that zn could not write to.
2. Check who owns that folder and its permissions. On macOS or Linux, run `ls -ld ~/.zn`.
3. If you own the folder, give your account write access, for example `chmod 700 ~/.zn`. In the test, changing the `.zn` folder to `755` made the line disappear, and the standard output matched the writable-home output.
4. If the home folder itself is read-only and `.zn` does not exist, zn cannot create it. Make the home folder writable for your account, or ask the person who manages the machine or the container.
5. Do not use `ZN_HOME` for this line. In the test, a writable `ZN_HOME` did not change the line: it still named the `.zn` folder under the home folder.
6. Run `zn-gate check` again. The line should be gone, and `zn-gate check --json` should show `"warnings": []`.

## More

- [Check that it works](../check.md): the full page, with the exit codes.
- [Troubleshooting: messages about files and folders](../troubleshooting.md#messages-about-files-and-folders).
- [First project walkthrough](first-project-walkthrough.md).
