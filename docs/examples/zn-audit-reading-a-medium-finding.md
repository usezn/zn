# Example: reading a medium audit finding

Most `zn audit` reports on a real repository have no critical finding. They have medium ones: not an emergency, but something to decide on. This page follows one medium finding from the output to a decision, on a made-up repository with one MCP server. The commands are in [`audit`](../cli.md#audit) and the rules in [`zn audit`](../audit.md). The run is real; the folder, the package name and every value are made up.

Run every command in your own terminal, not through your agent. `audit` only reads files: it runs nothing from the repository and sends nothing.

## 1. The repository

The repository ships a file `.mcp.json` that starts one MCP server through `npx`:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "example-notes-mcp"]
    }
  }
}
```

## 2. Run the audit

```bash
npx -y zn-gate audit ./example-repo
```

```text
zn audit  ./example-repo  (zn-gate 1.15.0)

MEDIUM    ZNA003  .mcp.json:3  [claude]
          Project MCP server starts a local command
          MCP server "notes" runs: npx -y example-notes-mcp
          evidence: "notes": {
          fix: Check the command and its package before approving the server; prefer pinned versions, or move the server to your user config.
          refs: CVE-2026-12957, CVE-2025-61260

MEDIUM    ZNA005  .mcp.json:3  [claude]
          MCP server or agent plugin package is not pinned
          MCP server "notes" runs example-notes-mcp through npx without an exact version.
          evidence: "notes": {
          fix: Pin an exact version (pkg@1.2.3, pkg==1.2.3, image@sha256:...).

2 findings (0 critical, 0 high, 2 medium, 0 low) in 1 file. Nothing at or above high.
```

The command exits `0`: the default `--fail-on high` only fails on a high or critical finding. A medium finding does not stop a CI job unless you ask for it. That is not the same as "nothing to do". Read each finding. How to read the lines is on [How to read the output](../audit.md#how-to-read-the-output).

## 3. Read one finding

Take the second one, `ZNA005`:

- `MEDIUM ZNA005 .mcp.json:3 [claude]`: the severity, the rule, the file and line, and the agent that reads the file.
- The title and the detail say it in plain words: the server runs `example-notes-mcp` through `npx` with no exact version.
- `evidence:` is the line that matched. Here it is the start of the server entry, so the finding is about the entry, not about one word in it.
- `fix:` is the action: pin an exact version.

Why it is medium and not high: the code that runs changes whenever the package is republished, so a compromised release reaches you the next time the server starts. That is a risk over time, not an attack that is already in the file. The [rules table](../audit.md#rules) says the same in the row for `ZNA005`.

The first finding, `ZNA003`, is about the same entry from another side: a project MCP server starts a local command with your rights, and some agents did not always ask before starting it (the `refs:` line names the advisories). Both findings point at the same line 3.

## 4. Decide

For a medium finding you have three honest answers:

1. **Fix it.** Pin the version. This is the cheapest answer for `ZNA005`:

   ```json
   "args": ["-y", "example-notes-mcp@1.4.2"]
   ```

2. **Accept it, and make the acceptance visible.** If you know the server and want to keep it as it is, run `npx -y zn-gate audit ./example-repo --approve` in your own terminal. It records the executable configuration of the project as approved and says `recorded 1 executable configuration entry as approved for this project.` Only names and hashes are stored, never a value.
3. **Do not use it.** Remove the server from the project, or do not open the repository with an agent.

Do not turn a medium finding into silence by lowering what the audit reports. Use `--fail-on` only to choose what fails a job.

## 5. Run it again

After pinning the version, the audit is shorter:

```bash
npx -y zn-gate audit ./example-repo --fail-on medium
```

```text
MEDIUM    ZNA003  .mcp.json:3  [claude]
          Project MCP server starts a local command
          MCP server "notes" runs: npx -y example-notes-mcp@1.4.2
          ...

1 finding (0 critical, 0 high, 1 medium, 0 low) in 1 file. Failing: severity >= medium.
```

`ZNA005` is gone. `ZNA003` stays, because the project still starts a local command, whatever its version. With `--fail-on medium` the command exits `1`; the default exits `0`. You can keep the answer you chose in step 4 for this one.

## 6. What an approval gives you later

After you approved the entry, the next audits keep reporting the medium finding, because it is still true. What changes is that a later edit to the entry is caught. If the pinned version changes from `1.4.2` to `1.5.0` after a pull, the next audit says:

```text
HIGH      ZNA023  .mcp.json:1  [any]
          Executable agent configuration changed since you approved it
          The entry mcp:notes in .mcp.json was changed since you approved this project.
          evidence: .mcp.json#mcp:notes
          fix: Review the changed entry (git diff shows what changed). If the change is yours, run `zn audit --approve` again to record it.
```

It is high, so the command exits `1`. See `ZNA023` in the [rules table](../audit.md#rules). `--approve` needs an interactive terminal; without one it says `zn audit --approve needs an interactive terminal. Open a terminal window yourself and run it there.` and exits `2`.

## Where to read more

- [`zn audit`](../audit.md), with every rule and option
- [Example: audit a repository before you open it](audit-before-opening.md)
- [Example: a repository you do not know yet](audit-before-adding-a-repo.md)
- [`audit`](../cli.md#audit) in the command line reference
