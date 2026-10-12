---
name: zn-audit
description: Audit the coding-agent configuration of a repository with zn-gate (MCP servers, hooks, plugins, skills and instruction files such as AGENTS.md or CLAUDE.md). Use when the user asks to review agent or MCP configuration for security problems, or before trusting a repository's agent settings.
---

# Audit agent configuration with zn

`zn audit` reads agent configuration files and reports risky settings, such as
MCP servers launched without a pinned version, hooks that run downloaded code,
secrets written into configuration, or instruction files with injected text.
It only reads files; it changes nothing and sends nothing over the network.

## Run it

From the repository root:

```bash
zn audit . --format text --fail-on none
```

For machine-readable output use `--format json`. The exit code is 0 when
nothing is at or above `--fail-on`, 1 when findings are, and 2 on an error.
`--include-home` also checks the user's own agent configuration in the home
directory; only use it when the user asks for it.

## Report the result

Summarize the findings by severity, with the file and line of each one and
the suggested fix from the report. Never copy secret values from the files
into your answer: quote the setting name and location instead. Ask the user
before you change any configuration file.

## In CI

The same check runs in GitHub Actions through the zn-gate action in
`usezn/zn`; see https://github.com/usezn/zn/blob/main/plugins/README.md.
