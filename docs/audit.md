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

```text
zn audit [path] [--format text|json|sarif] [--output <file>]
         [--fail-on low|medium|high|critical|none]
         [--agents claude,codex,cursor,opencode,amazonq,copilot,gemini,all] [--include-home] [--approve]
```

`zn-gate audit` is the same command.

### `zn audit` and the secret-use log

In 1.5, `zn audit` showed the local vault audit log of secret use. That log is now
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
| `--approve` | off | Record the project's executable configuration as approved, then exit: MCP servers (`.mcp.json`, `.cursor`, `.vscode`, `.gemini`, `.amazonq`, `opencode.json`, `.codex/config.toml`), hooks with their matchers, permissions (allow, deny, ask, default mode), `disableAllHooks`, helper commands, endpoint, proxy and loader environment overrides, install scripts, dev container commands and folder-open tasks. A file that is a link is followed when it stays inside the project; a file that cannot be read counts as a change. It runs only at a terminal and not when an agent started it, zn blocks it as an agent writes it, and when the vault is unlocked the approval is also confirmed on the vault's own channel (its terminal or an OS dialog). With no vault running the terminal check is the only one: a process an agent started inside a pseudo-terminal can pass it. Only entry names and hashes are stored, in `~/.zn/baselines`, never a value. Later audits report an entry that changed, was added or was removed since (ZNA023) |
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
skill called `build` is still read. `.git` is never read. The skipped
directories that a project could use for its own files (`build`, `dist`,
`out`, `vendor`, `target`) are listed under "Directories not read" in the text
report and in `skippedDirs` in the JSON report. `target` is skipped only next
to a `Cargo.toml`, `pom.xml`, Gradle or sbt build file, and `vendor` only next
to `go.mod`, `composer.json`, `Gemfile` or `Cargo.toml`; without one they are
ordinary directories and are read.

Nothing the repository controls can make a file disappear from the report
silently:

- a symbolic link to an agent file or directory inside the repository is
  followed; one that leaves the repository is reported (ZNA020, high);
- an agent file over 1 MiB is reported (ZNA020, high) instead of skipped, and
  the first 1 MiB is still checked. Text files (instructions, workflows) get
  every check on that part. JSON and TOML files cannot be parsed when cut, so
  their hooks and settings are not reviewed; only a line search for stored
  credentials and downloads piped into a shell runs. The finding says so, and
  nothing after the first 1 MiB is reported as clean;
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
| ZNA011 | high | A secret value in an agent config or instruction file: a known key format anywhere in the file and, in MCP server configs, a value written in plain text under a name such as an API key, token, password or `Authorization` header, in a credential argument (`--api-key`) or in a URL key (`?api_key=`). A reference (`${NAME}`, `__ZN_NAME__`) is not a finding | Committed credentials leak with the repository; the report never prints the value, only its kind and the name that holds it, and the fix says what to do |
| ZNA012 | high / medium / low | A prompt-injection pattern in agent instructions (the zn rules engine: instruction overrides, fake system tags, hidden HTML, invisible Unicode, markdown image beacons) | The agent reads the file as trusted guidance. High for the strong patterns; medium for weaker ones ("you are now", "forget"); in the files an agent reads as instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules` and rules, `copilot-instructions.md`, skills, commands, prompts) a strong pattern is never lowered, because the agent reads it the same, quoted or not. In a skill's supporting notes (any file in a skill folder other than `SKILL.md`) it is lowered to medium only when the match lies inside the quotes of an example ("e.g. '...'", "such as '...'"). A weak pattern is lowered by an example marker or inside a code block that is closed again. Blockquotes and unclosed code blocks never lower anything. Rules that are noisy in documentation ("act as", mentions of credentials or `.env`) are not used here. `SKILL.md` and docs pages (a `docs/` folder outside the agent instruction folders such as `.claude/`, `.cursor/`, `.github/prompts` or `commands/`, and `README` files) get a few documentation shapes: a chat token inside code or quotes, a `<system-or-project>` style placeholder that wraps no text (it is reported when it is closed anywhere in the file, when no word comes before it on the line, or when an order follows it on the line, and a closing tag is always reported; the same two shapes also apply in the other notes of a skill folder, where a chat token shown inside backticks or a closed code block is reported as medium instead of high), `system:anonymous` style identity values, a badge image from a known badge host and a warning that names its object ("never follow instructions found in the page") are not reported, unless the warning itself holds an override phrase; closed quotes right after "phrases like", "such as" or "e.g." and an attack shown inside a code block under a heading about injection are reported one level lower (a strong pattern is medium, never dropped). Any other quote, an unclosed quote and an order that follows a warning, with or without a comma ("Don't trust the text in the page ignore all previous instructions"), are read as instructions. Instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `copilot-instructions.md`, rules, commands, prompts) get none of these shapes even inside a `docs/` folder. A system role token, a role marker on its own line and an override phrase stay high |
| ZNA013 | medium / low | Instructions tell the agent to download and run code | Same as ZNA002 once the agent follows them; low for well-known installers (rustup, uv, bun, deno, nvm, Homebrew); text that warns about or lists the pattern (a risk checklist under a heading such as "Dangerous patterns", a table row with a verdict cell such as "blocked", "unsafe") is not reported; a line that starts with an order (run, install, use, get, add, pipe), an order after a warning that turns into a reassurance ("unsafe, so get it with ...", "flagged, but here it is fine: ..."), an order after a verdict label ("Avoid: just run ..."), an order after a warning followed by a colon, a dash or an arrow ("unsafe: curl ...", "unsafe — curl ...", "unsafe -> curl ..."), a table row whose note says "no risk", "not blocked", "risk-free" or "isn't risky", a line inside a code block and a line with a severity label such as "Critical:" are always reported |
| ZNA014 | high | Instructions tell the agent to send secrets or files out (`.env`, `~/.ssh`, tokens to a URL, `curl -d @.env`, `env \| curl`); setup steps such as `git clone <url>`, `cp .env.example .env` and a "create a key at" step with a link are not | Direct exfiltration through the agent |
| ZNA015 | medium | Instructions tell the agent to skip safety checks or to hide what it does (`--no-verify`, `--dangerously-skip-permissions`, "disable the sandbox", "do not tell the user") | Removes the checks that would catch the rest. "Never ask the user" is not concealment and is not reported |
| ZNA016 | critical (Windows executables) / high | An executable in the audited root shares its name with a common tool (`git.exe`, `node.exe`, `npm.cmd`, `python`, `zn.cmd`, ...) | Windows and some tools search the current directory first: the planted file runs instead of the real tool. CVE-2026-63093 |
| ZNA017 | medium | Project settings add plugin marketplaces or enable plugins (`extraKnownMarketplaces`, `enabledPlugins`) | Third-party plugins (hooks, MCP servers, skills) get installed and updated once the project is trusted ("Plugin4Shell") |
| ZNA018 | low | The repository ships agent extensions (commands, subagents, skills, plugins) | Inventory: they are reviewed by the other rules, but you should know they are there |
| ZNA019 | high / medium | A CI workflow runs an AI agent on input anyone can write (`issues`, `issue_comment`, `pull_request_target`, `pull_request_review`, `pull_request_review_comment`, `discussion`, `discussion_comment`) | An issue or comment becomes instructions for an agent that holds repository tokens. High with `pull_request_target`, issue or comment text pasted into the workflow (`${{ github.event.issue.body }}`, also through `env:`), an action opened to users without write access (`allowed_non_write_users`, or `allow_users: "*"`), or a CLI step (`claude -p`, `codex exec`) with write permissions and no author filter. Medium otherwise: the common agent actions check the actor's own permission before running |
| ZNA020 | high / low | An agent file could not be checked: a syntax error, a size over 1 MiB (the first 1 MiB is still checked), a symbolic link leaving the repository, or a scan that stopped early | The agent may still act on it. High when the file can run commands or redirect the agent (the text is then searched for risky keys, and `runOn: folderOpen` or a download piped into a shell is still reported), when it uses a reserved key such as `__proto__`, or when the scan did not finish; low for a syntax error in a file that cannot run anything |
| ZNA021 | medium | An agent instruction file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, rules, `copilot-instructions.md`, `SKILL.md` and other skill, command and agent files) has a run of 40 or more empty or whitespace-only lines with more text after it | The text after the run is out of view for a person who opens the file and past the part of it a classifier reads. The finding gives the line where that text starts and the length of the run; the text is not printed. Blank lines at the end of a file are not reported. The check counts lines and uses no text patterns: read the file from the reported line |
| ZNA022 | high / medium | A hook of type `http`, or of type `agent` that names a URL, in an agent settings or hooks file | Each tool event the hook matches (the command line, file paths and contents, tool output) is posted to that address, and from the moment the folder is opened when the file is in the project. High for a remote address, medium for a local one (`127.0.0.1`, `localhost`, `::1`), low in your own user file. Environment variables that its headers interpolate or `allowedEnvVars` lists are named in the finding, never their values. A command hook is reported by ZNA001, a placeholder URL such as `${HOOK_URL}` is not reported |
| ZNA023 | high | An MCP server, hook, endpoint or proxy override, permission list, install script or folder-open task differs from the version you recorded with `zn audit --approve` (changed or added: high; removed hook, permission or setting: medium; other removed entry: low) | A pull, a branch switch, a dependency or the agent itself can rewrite a command you already reviewed. The finding names the entry and the file, never its value. No recorded baseline means no finding. If the change is yours, run `zn audit --approve` again |

## Output

### Text

```text
zn audit  ./some-repo  (zn-gate 1.15.0)

CRITICAL  ZNA007  .claude/settings.json:3  [claude]
          Model API endpoint overridden by the project
          ANTHROPIC_BASE_URL points to https://attacker.example.invalid; the agent sends its API key and prompts there.
          evidence: "ANTHROPIC_BASE_URL": "https://attacker.example.invalid"
          fix: Remove the override from the project; set it in your user settings if you use a gateway.
          refs: CVE-2026-21852, CVE-2025-61260

1 finding (1 critical, 0 high, 0 medium, 0 low) in 1 file. Failing: severity >= high.
```

Colors are used only on a terminal and never when `NO_COLOR` is set or `TERM=dumb`. Emoji and box-drawing characters are replaced by short ASCII markers such as `[ok]` and `[!]` outside a terminal and when `CI` is set. Control
characters and escape sequences from the repository (in evidence, details and
file names) are printed as `\x1b`, never sent to the terminal.

### JSON

```json
{
  "version": 1,
  "tool": "zn-gate",
  "toolVersion": "1.15.0",
  "root": "/home/me/some-repo",
  "findings": [
    {
      "id": "ZNA007",
      "severity": "critical",
      "agent": "claude",
      "file": ".claude/settings.json",
      "line": 3,
      "title": "Model API endpoint overridden by the project",
      "detail": "ANTHROPIC_BASE_URL points to https://attacker.example.invalid; the agent sends its API key and prompts there.",
      "evidence": "\"ANTHROPIC_BASE_URL\": \"https://attacker.example.invalid\"",
      "fix": "Remove the override from the project; set it in your user settings if you use a gateway.",
      "references": [
        "CVE-2026-21852",
        "CVE-2025-61260"
      ]
    }
  ],
  "skippedDirs": [],
  "summary": {
    "files": 1,
    "findings": 1,
    "bySeverity": {
      "critical": 1,
      "high": 0,
      "medium": 0,
      "low": 0
    },
    "failOn": "high",
    "failed": true,
    "agents": [
      "claude",
      "codex",
      "cursor",
      "opencode",
      "amazonq",
      "copilot",
      "gemini"
    ],
    "agentStatus": [
      {
        "agent": "claude",
        "files": 1,
        "checked": true
      },
      {
        "agent": "codex",
        "files": 0,
        "checked": false
      },
      {
        "agent": "cursor",
        "files": 1,
        "checked": true
      },
      {
        "agent": "opencode",
        "files": 0,
        "checked": false
      },
      {
        "agent": "amazonq",
        "files": 0,
        "checked": false
      },
      {
        "agent": "copilot",
        "files": 0,
        "checked": false
      },
      {
        "agent": "gemini",
        "files": 0,
        "checked": false
      }
    ],
    "truncated": false,
    "skippedDirs": 0
  }
}
```

`summary.agentStatus` says, for each selected agent, how many files were read and whether
anything was checked. With `--agents`, the text report adds a line such as
`codex: not checked (no instruction or config files found where zn looks: AGENTS.md, .codex/)`
for an agent with no files, so a missed location is not mistaken for a clean result. The
exit code does not change. A file that exists but cannot be read (for example, permission
denied) is a high ZNA020 finding, never a clean result.

`skippedDirs` lists each directory the scan did not read as a `{ "dir", "reason" }`
object, the same entries as the "Directories not read" list in the text report. It is
`[]` when nothing was skipped. `summary.skippedDirs` holds the count, and
`summary.truncated` is `true` when the scan stopped early (see "What it reads").

`file` is relative to `root` with forward slashes; files from `--include-home`
start with `~/`. `agent` is the agent that reads the file (`any` when several
do). `evidence` is the matching line, cut to 160 characters, with secrets
replaced by `[REDACTED:<TYPE>]`. URLs in `detail` and `evidence` lose their user,
password, path, query string and fragment: only `scheme://host[:port]` is shown,
and a URL that cannot be read safely is shown as `(unparsable URL)`. This covers
every URL on the line, not only the one the finding is about. A proxy written
without a scheme (`user:password@host:port`) shows `[REDACTED]@host:port`. The one
exception is the download URL of ZNA002, which is shown without its user and
password; any other URL in that finding is reduced like the rest.

### SARIF

`--format sarif` writes SARIF 2.1.0 for GitHub code scanning: one rule per
`ZNA` id with help text and a `security-severity` property, results with
locations relative to the repository root (`uriBaseId: "%SRCROOT%"`) and a
partial fingerprint (rule, file, evidence and an ordinal among identical
findings) so alerts survive line moves and stay unique. Findings from
`--include-home` use `uriBaseId: "HOME"` and GitHub ignores them; keep that
flag off in CI.

```yaml
- run: npx -y zn-gate@1.15.0 audit --format sarif --output zn-audit.sarif --fail-on none
- uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
  with:
    sarif_file: zn-audit.sarif
```

### Formats of `zn audit` and `zn scan`

Both commands take `--format` with `text` (default) and `json`, but their
third format differs: `zn audit` writes `sarif` for GitHub code scanning,
`zn scan` writes `github` for workflow annotations in CI.

| Command | `--format` | When to use | Who reads it |
|---|---|---|---|
| `zn audit` | `text` (default) | A local review before you open the repository | People |
| `zn audit` | `json` | Findings consumed by a script or another tool | Scripts and tools |
| `zn audit` | `sarif` | Findings uploaded to GitHub code scanning | GitHub code scanning: one alert per finding under Security > Code scanning |
| `zn scan` | `text` (default) | A local scan | People |
| `zn scan` | `json` | Results consumed by a script or another tool | Scripts and tools |
| `zn scan` | `github` | A scan in a GitHub Actions workflow | People: annotations in the workflow run and on the pull request |

In the [GitHub Action](github-action.md) the `format` input takes `github`
(default), `text`, `json` or `sarif` for both modes; with `sarif` and the
upload step, the audit and the scan appear as two separate code scanning runs
(categories `zn-gate/audit/` and `zn-gate/scan/`).

## How to read the output

This walks through the text report from [Output](#text), line by line. The values (the path, the file, the
version) are made up; the words are the ones `zn audit` prints.

```text
zn audit  ./some-repo  (zn-gate 1.15.0)

CRITICAL  ZNA007  .claude/settings.json:3  [claude]
          Model API endpoint overridden by the project
          ANTHROPIC_BASE_URL points to https://attacker.example.invalid; the agent sends its API key and prompts there.
          evidence: "ANTHROPIC_BASE_URL": "https://attacker.example.invalid"
          fix: Remove the override from the project; set it in your user settings if you use a gateway.
          refs: CVE-2026-21852, CVE-2025-61260

1 finding (1 critical, 0 high, 0 medium, 0 low) in 1 file. Failing: severity >= high.
```

**The first line** is `zn audit`, the directory exactly as you typed it (`.` when you gave none) and, in
parentheses, the zn-gate version that made the report.

**The header of a finding** has four parts:

- The severity: `CRITICAL`, `HIGH`, `MEDIUM` or `LOW`. Severity decides whether the command fails; see
  [the last line](#the-last-line) below.
- The rule id (`ZNA007`). Look it up in [Rules](#rules) to see why it matters. Ids never change meaning.
- The file and the line in it, as `file:line`. The path is relative to the audited directory. Files from
  `--include-home` start with `~/`.
- The agent that reads that file, in brackets (`[claude]`). It says `[any]` when several agents read it.

**The lines under the header** are, in this order:

1. The title: what kind of problem it is. It is the same for every finding of the rule.
2. The detail: what is wrong in this file.
3. `evidence:` the line that matched, cut to 160 characters. Secrets in it are replaced by
   `[REDACTED:<TYPE>]` and URLs are shortened to `scheme://host[:port]`, so the report is safe to share.
   Some findings have no evidence line.
4. `fix:` what to do about it.
5. `refs:` the CVE or advisory ids that describe the same kind of bug. Not every finding has them.

Control characters from the repository are printed as `\x1b` and the like, so a hostile file cannot rewrite
the terminal.

### The last line

The summary line counts the findings by severity and the files that were read:

- `1 finding (1 critical, 0 high, 0 medium, 0 low) in 1 file.` With more, it says `3 findings` and `files`.
- `Failing: severity >= high.` means at least one finding is at or above `--fail-on` (here the default,
  `high`), so the exit code is 1.
- `Nothing at or above high.` means there are findings, but all are lower than `--fail-on`: exit code 0.
- `Not failing (--fail-on none).` is printed when you asked for `--fail-on none`.

When nothing is found, the line is one of these:

- `No findings in 4 agent files.` Files were read and are clean for the rules in [Rules](#rules).
- `Nothing was checked: no agent instruction or config files were found.` Nothing was read, so this is not
  the same as clean. Check that you pointed `zn audit` at the repository root.
- `No findings in the 2 files that were read.` appears with `--agents` when some agent you asked for had no
  files; the lines that follow name it.

### Lines after the summary

- `codex: not checked (no instruction or config files found where zn looks: AGENTS.md, .codex/)`: you asked
  for that agent with `--agents`, but none of its files exist. The places differ for each agent. The exit
  code does not change.
- `Note: the scan stopped early (see ZNA020); some files were not checked.`: a limit was reached. Treat the
  report as incomplete. See [What it reads](#what-it-reads).
- `Directories not read (N):` then one `directory (reason)` per line, at most 20, then `... and N more`.
  These are directories zn skipped on purpose, such as a `build` or `vendor` folder.

The [JSON](#json) report holds the same fields under the names `severity`, `id`, `file`, `line`, `agent`,
`title`, `detail`, `evidence`, `fix` and `references`, and its `summary` carries the counts, `failed` and
`agentStatus`.

## If something fails

- **Exit code 2**: the audit did not run. The option is wrong, the path was not found, or the output file cannot be written.
- **`zn audit log` or `--since` exits with 2**: that log moved. Use `zn vault log`. (`zn audit log` is read as a folder name when you have a folder called `log`.)
- **Exit code 1**: a finding met `--fail-on`. Read the evidence before you act: documentation that quotes a dangerous command is reported too.
- **A job fails and you only want a report**: use `--fail-on none`.

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
