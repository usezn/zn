# Command cheat sheet

One page with every `zn-gate` command, its most useful flags and one example. Everything here comes from the [command line reference](cli.md), which has the full options and exit codes. `zn` and `zn-mcp` are the same program. Without installing, use `npx -y zn-gate <command>`.

## Set up and check

| Command | Useful flags | Example |
|---|---|---|
| [`init`](cli.md#init) | `--wrap-mcp`, `--dry-run`, `--shadow`, `--revert` | `zn-gate init --wrap-mcp --dry-run` |
| [`uninstall`](cli.md#uninstall) | `--dry-run` | `zn-gate uninstall --dry-run` |
| [`check`](cli.md#check) | none (alias `doctor`) | `zn-gate check` |
| [`status`](cli.md#status) | none | `zn-gate status` |
| [`test`](cli.md#test) | none | `zn-gate test` |
| [`version`](cli.md#version) | `-V`, `--version` | `zn-gate version` |
| [`connect`](cli.md#connect) | `--reconnect` | `zn-gate connect` |
| [`disconnect`](cli.md#disconnect) | `--revoke`, `--no-revoke` | `zn-gate disconnect --no-revoke` |

## Scan and review

| Command | Useful flags | Example |
|---|---|---|
| [`scan`](cli.md#scan) | `--format text\|json\|github`, `--all`, `--include`, `--exclude`, `--include-home` | `zn-gate scan ./docs --format json` |
| [`audit`](cli.md#audit) | `--format text\|json\|sarif`, `--output`, `--fail-on`, `--agents`, `--include-home` | `zn-gate audit . --fail-on high --agents claude,codex` |
| [`reach`](cli.md#reach) | `--json`, `--sarif`, `--fail-on`, `--remember` | `zn-gate reach . --fail-on high` |
| [`analyze`](cli.md#analyze) | none | `zn-gate analyze "Summarize this file"` |
| [`pins`](cli.md#pins) | `approve <server>`, `approve --all` | `zn-gate pins` |

## Secrets and the vault

Commands that add, change or remove a value need an interactive terminal. A value is never passed as an argument. See the [walkthrough](secrets.md).

| Command | Useful flags | Example |
|---|---|---|
| [`secret set`](cli.md#secret-set) | `--clipboard`, `--force`, `--mode`, `--host`, `--command`, `--in` | `zn-gate secret set API_TOKEN --host api.example.com` |
| [`secret list`](cli.md#secret-list) | none (alias `secret ls`) | `zn-gate secret list` |
| [`secret rm`](cli.md#secret-rm) | none | `zn-gate secret rm API_TOKEN` |
| [`secret allow`](cli.md#secret-allow) | `--host`, `--command`, `--in`, `--mode`, `--replace` | `zn-gate secret allow API_TOKEN --host api.example.com` |
| [`secret approve`](cli.md#secret-approve) | `--command` | `zn-gate secret approve API_TOKEN --command "psql"` |
| [`secret import`](cli.md#secret-import) | `--all`, `--keys`, `--host`, `--command`, `--force` | `zn-gate secret import .env --keys A,B` |
| [`secret adopt`](cli.md#secret-adopt) | `--name`, `--host`, `--command` | `zn-gate secret adopt AWS_KEY_1 --name AWS_PROD` |
| [`secret log`](cli.md#secret-log) | `--since` | `zn-gate secret log --since 1h` |
| [`env shadow`](cli.md#env-shadow) | `--all`, `--keys`, `--host`, `--command`, `--force`, `--dry-run` | `zn-gate env shadow .env --dry-run` |
| [`env unshadow`](cli.md#env-unshadow) | `--backup` | `zn-gate env unshadow .env --backup ENVBAK_NAME` |
| [`run`](cli.md#run) | `--secrets` (`-s`), `--agent` | `zn-gate run --secrets API_TOKEN -- psql` |
| [`unlock`](cli.md#unlock) | `--ttl`, `--idle`, `--backend`, `--passphrase-stdin`, `--foreground` | `zn-gate unlock --ttl 8h --idle 30m` |
| [`lock`](cli.md#lock) | none | `zn-gate lock` |
| [`vault status`](cli.md#vault-status) | none | `zn-gate vault status` |
| [`vault log`](cli.md#vault-log) | `--since` | `zn-gate vault log --since 1h` |
| [`vault log export`](cli.md#vault-log-export) | `--otlp`, `--since`, `--out` | `zn-gate vault log export --otlp --since 7d --out audit.jsonl` |
| [`vault verify`](cli.md#vault-verify) | `--acknowledge` | `zn-gate vault verify --acknowledge` |
| [`vault forget`](cli.md#vault-forget) | `[dir]` | `zn-gate vault forget .` |
| [`vault reset`](cli.md#vault-reset) | none | `zn-gate vault reset` |
| [`vault purge`](cli.md#vault-purge) | `--yes` | `zn-gate vault purge` |
| [`vault team`](cli.md#vault-team) | none | `zn-gate vault team` |

`zn-gate secret get NAME` never prints a value: it exits `77` and points you to `run`.

## Hooks and MCP servers

| Command | Useful flags | Example |
|---|---|---|
| [`hooks install`](cli.md#hooks-install) | `--project`, `--no-mcp` | `zn-gate hooks install claude-code --project` |
| [`hooks uninstall`](cli.md#hooks-uninstall) | `--project`, `--no-mcp` | `zn-gate hooks uninstall claude-code --project` |
| [`hook`](cli.md#hook) | none (the agents call it, you do not) | `zn-gate hook <agent>` |
| [`secrets-mcp`](cli.md#secrets-mcp) | `--agent` | `zn-gate secrets-mcp --agent claude-code` |
| [`mcp`](cli.md#mcp) | none | `zn-gate mcp` |
| [`shield`](cli.md#shield) | `-- <command> [args...]` (aliases `mcp-shield`, `wrap`) | `zn-gate shield -- uvx mcp-server-fetch` |

## Logs and reports

| Command | Useful flags | Example |
|---|---|---|
| [`evidence`](cli.md#evidence) | `--verify`, `--ui`, `--port`, `--export`, `--format`, `--output`, `--tail` | `zn-gate evidence --verify` |
| [`stats`](cli.md#stats) | `--days`, `--json` | `zn-gate stats --days 30` |
| [`stats share`](cli.md#stats-share) | `on`, `off`, `status`, `show` | `zn-gate stats share status` |
| [`report`](cli.md#report) | `--since`, `--json`, `--no-team-line` | `zn-gate report --since 7d` |

## zn Team

Needs the vault unlocked. See [zn Team](team.md).

| Command | Useful flags | Example |
|---|---|---|
| [`team join`](cli.md#team-join) | `--api`, `--agent`, `--include-history` | `zn-gate team join -` |
| [`team status`](cli.md#team-status) | `--json` | `zn-gate team status --json` |
| [`team sync`](cli.md#team-sync) | none | `zn-gate team sync` |
| [`team leave`](cli.md#team-leave) | none | `zn-gate team leave` |
| [`team managed-config`](cli.md#team-managed-config) | `--agent`, `--os`, `--managed-hooks-only`, `--exclusive-mcp`, `--json` | `zn-gate team managed-config --agent claude-code --os linux` |

## Common settings

| Setting | Effect |
|---|---|
| `--help`, `-h` | Print the short help. |
| `--local-only` | Never use the cloud check. |
| `--verbose` | Print debug messages to the error output. |
| `NO_COLOR` | Turn off colors. |

Exit codes: `0` done, `1` a problem was found, `2` wrong usage (or `analyze` blocked the text), `64` wrong usage for the secrets commands, `77` refused on purpose, `127` `run` could not find the program. Each command lists its own codes in the [reference](cli.md#exit-codes).
