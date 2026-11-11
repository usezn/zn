# Example: which command shows what

Six common questions about zn-gate, and the command that answers each one. One row per question: the command, an example and the page to read. Everything here comes from the [command line reference](../cli.md), the [cheat sheet](../commands-cheatsheet.md) and [the report page](../report.md).

| Question | Command | Example | Page to read |
|---|---|---|---|
| Is zn-gate set up for my agent? | `zn-gate check` | `zn-gate check` | [`check` in the CLI reference](../cli.md#check) |
| What did it do this week? | `zn-gate report` | `zn-gate report` | [What the report shows](../report.md) |
| Can my agents reach anything sensitive? | `zn-gate reach` | `zn-gate reach .` | [`reach` in the CLI reference](../cli.md#reach) |
| Was the decision log changed? | `zn-gate evidence --verify` | `zn-gate evidence --verify` | [`evidence` in the CLI reference](../cli.md#evidence) |
| Is this repository's agent setup safe to open? | `zn-gate audit` | `zn-gate audit .` | [`audit` in the CLI reference](../cli.md#audit) |
| Does this folder contain anything flagged? | `zn-gate scan` | `zn-gate scan .` | [`scan` in the CLI reference](../cli.md#scan) |

## What each answer looks like

- `check` runs a safe test with a fake secret in a temporary folder and changes no settings; it fails when an agent is not protected or none is set up.
- `report` prints a short summary of recent days on this computer: blocked actions, secrets hidden, new protected MCP servers and tool changes waiting for approval. It is built from local files and nothing is sent.
- `reach` shows what your coding agents can reach from a folder: secrets (names only), credential files and MCP servers. It is read only and nothing is sent.
- `evidence` shows the local hash-chained log of what zn-gate decided; with `--verify` it checks the chain and fails when the log was changed.
- `audit` reviews the agent configs of a folder before you open it - hooks, MCP servers, endpoint overrides, permissions, instructions and planted programs - and runs nothing.
- `scan` looks through prompt templates, markdown, skills and configs for injection traps and secrets; matched values are never printed.

For every command and flag, read the [cheat sheet](../commands-cheatsheet.md) or the [command line reference](../cli.md).
