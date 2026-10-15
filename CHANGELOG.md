# Changelog

All notable changes to `zn-gate` (Node.js & Python SDKs) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Codex plugin layout: `plugins/tools/check-plugins.js` now checks the root manifest's `extensions.com.openai.hooks` path and the repository marketplace entry against OpenAI's Codex plugin documentation.
- MCP tool pinning: `zn-gate shield` records a hash of each tool of a wrapped server (the whole tool definition) from the first tool list it sees for that server (all its pages), and compares every later list with it. By default a tool that is new or changed since gets a notice at the start of its description that tells the model to ask you first, and the shield writes a warning; tools with a duplicated or invalid name are refused. With `"mcpPinning": "block"` in `~/.zn/config.json` (or `ZN_MCP_PINNING=block`) such tools are removed and calls to any tool that is not approved are refused. Only your own `~/.zn/config.json` can make the mode weaker than `warn`; the environment of an MCP server can only make it stricter. `zn-gate pins` lists the servers and what changed; `zn-gate pins approve <server>` accepts the changes, only in an interactive terminal, and the agent hooks refuse it from an agent. Pins are kept in `~/.zn/mcp-pins/` (the program, its arguments with secrets redacted, tool names and hashes). Limits: pinning covers tool definitions, not the server's code; the first list of a server is trusted, and so is the first list after its command line changes (for example a new package version); approving accepts the tools as they are listed then (the pins hold names and hashes, not the tool text); an agent that can run code on your machine can edit the pins or start a server without the shield, and the hooks only stop the commands they recognise (`POLICY_RULES_VERSION` is now `2026-10-15.13`).
- CI: a `Public facts` check fails a pull request when the release version, the agents with hooks, the license or the install command differ between the package and plugin manifests, the MCP Registry files and the pinned versions in the documentation (`.github/public-facts.json`).
- zn Team: a policy rule can warn instead of block (`"warn": true`). The use goes ahead, an audit record with the decision `warn` is written and uploaded to your organization, and you and the agent see `zn: your team policy would block <NAME> here (policy note: "<reason>"). It was allowed and recorded for your organization.` It applies wherever a block applies (`zn run`, `secrets_http_request`, `secrets_render_file`); a rule with both `deny` and `warn` makes the policy invalid. zn-gate now sends `X-ZN-Policy-Features: warn` when it downloads the policy, so the server sends `warn` rules only to versions that understand them. The OpenTelemetry export maps `warn` to severity `WARN`.

### Changed
- Block messages in plain words, second batch. PowerShell refusals, MCP and Monitor notices, and the notes on commands with secret placeholders now say what happened and give one next step. Errors a person reads gain a specific next step where they are raised, written for a person first and for an agent second; the "Not allowed" and "Not found" prefixes are unchanged. The Python guard returns one message with the reason and a next step: a blocked input says not to retry with reworded text, and a blocked tool result says not to use that result. The Python block text no longer shows the confidence value; read the rule and reason from the exception's `assessment` attribute. The default CrewAI fallback text changed: pass `fallback=` to keep a fixed string. (`POLICY_RULES_VERSION` is now `2026-10-15.14`.)
- Block messages in plain words. When zn cannot read a credential file for the agent, the message names the file, says why and how to use the value instead (`zn secret set NAME`, then `__ZN_NAME__` in the command). A secret used in the wrong place of a shell command gets one short explanation and an example. When a command is not allowed to use a secret, `zn run` says so and gives the command to allow it. When the hook itself fails, the agent reads that the action was blocked and, if it happens again, to ask you to run `zn hooks install`, followed by the error detail. The text that replaces a tool output with instructions aimed at the agent now tells the agent not to act on it and to tell you (`POLICY_RULES_VERSION` is now `2026-10-15.3`).

### Fixed
- zn Team: `secrets_render_file` now applies an organization `deny`. Before, a `file` mode secret blocked by the organization policy could still be written to a file through this tool.
- Plugin repository checks: the Verify workflow no longer stops without a message on a release pull request (the comparison of the two trees ended the step under `pipefail`).
- Release tooling: `plugins/tools/pin-release.js` also moves the plugin manifests, the MCP Registry entry of the plugin and the version named in the plugin docs, in the same commit as the pin. The Plugin repository workflow reads the version from the pin and stops with a message when the plugin manifest names another version.

### Security
- A value the scrubber replaced with a token is not put back when it is also a stored secret that the organization's policy blocks. When the vault process was started by an older zn-gate, the hooks keep tokens as they are instead of restoring them and say so to you and the agent; `zn unlock` now restarts such a vault, and `zn vault status` shows the running vault's zn-gate version and flags an outdated one.
- Marker restores in the agent hooks now apply the organization's policy. When an agent writes a `__ZN_NAME__` marker into a git-ignored file, a secret the zn Team policy blocks stays a marker and the hook says why; a secret under a `warn` rule is restored, recorded with the decision `warn`, and the hook's message shows the warning.
- The Rust gateway's lockfile uses wasmtime 48.0.6, which fixes RUSTSEC-2026-0353, 0358, 0359, 0361, 0362, 0363 and 0364 in 48.0.5. The gateway runs WebAssembly rules through the synchronous module API, without the component model or async calls where most of these issues are. The npm and PyPI packages do not contain the Rust gateway.
- When an event cannot be read or part of zn-gate is missing, the message the agent reads no longer says how to let actions pass unchecked (`hooks.whenUnavailable`). That setting is still documented and is shown only to you (as the hook's message to the user in Claude Code).
- When an agent event is not valid JSON, the refusal no longer quotes the part of it that Node's parser shows, which could be tool output.

## [1.7.1] - 2026-10-15

**If you use the zn-gate agent hooks, update.** This release makes the hooks' glob matching and path resolution run in linear time, and `zn-gate scan` for Node.js never prints matched values.

### Security
- `zn-gate scan` for Node.js no longer prints matched values in any output format (the Python package already redacted them): the line shown with a finding also goes through the scrubber's secret patterns. `scan` now accepts `--format json` and `--format github` like the Python CLI (the GitHub annotations show rule, reason, file and line only). Before, Node.js ignored `--format`; an unknown format now exits with code 2.
- Glob matching, brace expansion and path resolution in the agent hooks run in linear time, and a bracket expression in a glob never matches a path separator, as in the shell (`POLICY_RULES_VERSION` is now `2026-10-15.11`).

## [1.7.0] - 2026-10-15

zn-gate 1.7.0 adds `zn-gate stats` (local counts of what zn-gate did), MCP argument checks in Cursor, a preview of the organization before `zn team join`, and an optional cloud classifier key for the Claude Code plugin. The Python package redacts the same provider tokens as Node.js, `zn-gate scan` lists the files it does not read, the Rust engine's rules are more precise, and the agent plugin launcher only loads verified files.

What can leave your machine, all off by default: with `zn-gate stats share on`, one pseudonymous report of counts a day (a random installation id, never values, prompts, names or paths); with the Claude Code plugin's API key, the text `analyze_prompt` checks, with secrets redacted, to api.usezn.com; and `zn team join` sends the join token to api.usezn.com for the preview before the confirmation dialog.

### Added
- Claude Code plugin: an optional API key setting (`api_key`, stored as a sensitive value) turns on the zn cloud classifier for the `analyze_prompt` tool only; the text it checks is sent to api.usezn.com with secrets redacted first. Without a key the plugin stays local, and `ZN_CLOUD`, `ZN_API_KEY`, `ZN_API_URL` and `ZN_STAGE` from the environment are still ignored.
- Claude Code plugin: a listing icon for the Claude plugin directory (`icon.png` at the plugin root, named in the manifest), and the plugin's contact email is now support@usezn.com (security reports still go to security@usezn.com).
- `zn-gate stats` (Node and Python) shows what zn-gate did on this machine: checks, blocks, secret values replaced before the model saw them, and the secret types found, per agent, for the last 30 days (`--days N`, `--json`). The agent hooks, the MCP tools and the shield proxy keep these counts in `~/.zn/stats.json` (numbers only; never values, prompts, paths or hosts). `ZN_STATS=off` turns counting off. Nothing is sent: sharing pseudonymous daily counts is a separate opt-in (`zn-gate stats share on`, `off`, `status`, `show`), off by default; when on, `zn-gate stats` sends one report per complete day with only the fields that `zn-gate stats share show` prints first.
- Sharing can only be turned on by you, in your own terminal, after a yes/no question: the agent hooks treat `zn-gate stats share on` as an admin command an agent cannot run. Only built-in secret types are counted: a variable or secret name you chose is counted as `OTHER` (or `ENV_VALUE` for a value matched by its variable name), never by its name.
- `zn vault team` says that a shared vault for teams is planned and counts the request on this machine only. Nothing is sent and no contact details are asked for.
- Cursor checks the arguments of MCP tool calls: a call that would send a secret value, or a `__ZN_` marker, to an MCP server other than zn's `secrets` server is denied. Run `zn hooks install cursor` again to add this hook.
- `zn team join` shows the organization name and who invited you in the vault's confirmation
  dialog, from `POST /v1/org/join-preview`, before this machine sends its audit key. The preview
  does not use up the join token; an invalid, expired or used-up token, or an organization without
  an active subscription, stops before the dialog. The check is made only against `api.usezn.com`:
  another server given with `--api` gets the token only after you confirm, as before. If the
  organization joined is not the one shown, the join is refused and nothing is saved. Names from
  the server are shown without control, zero-width or bidirectional characters.

### Changed
- `zn-gate scan` (Node.js and Python) reports the files it does not read: files of 2 MiB or more, binary `.key` files and files that cannot be read (Python also lists pipes and other files that are not regular files, which it no longer opens). Node prints them after the summary; Python lists them in text output, as `::notice` lines with `--format github`, and as `skipped` with `total_skipped` in JSON. Python's JSON `total_files` now counts only the files that were read.
- Claude Code plugin: the manifest's homepage and documentation links point to usezn.com instead of a folder of this repository.
- The Rust engine's prompt-injection rules return a stable rule ID (for example `pi:ignore_previous`; the block message reads "Prompt Injection blocked: pi:<id>") and use a grammar based on the Node.js rules for "ignore / disregard / forget ... instructions", so phrasings such as "ignore the instructions above" or "ignore these instructions" are caught while "you can ignore the build instructions" is not. Phrases that are common in ordinary text are no longer blocked: "act as a", "respond as a", "debug mode", "root access", "shell access", "user message:", "end of conversation", "end of transmission", "stay in character", "prompt injection", "stop what you are doing", "without any restrictions", "imagine you are a", "into developer mode", "switch to developer mode" and "override system" (now only "override the system prompt" and similar). "system message:" and "new instructions:" count only at the start of a line, "forget everything" only at the end of a clause or followed by "above", "before" or "you know/were told", "do anything now" only as "you can do anything now" or with "DAN", and "jailbreak" must be a whole word.
- The hook policy rules are at `POLICY_RULES_VERSION` `2026-10-14.10` (see the entries below that change them).

### Fixed
- The Rust engine's restricted-commands rule now matches whole words in tool names too, so tools such as `transform_data`, `perform_search` or `add_item` are no longer blocked as `rm` or `dd`; `format_disk`, `runShutdown` and `rm` still are.
- The Rust engine's log scrubber now redacts card numbers only when they pass the Luhn check and match a card network, US SSNs only with a valid area, group and serial, and phone numbers only in E.164 form or as a formatted North American number, never a digit run inside a longer number. IDs and timestamps are no longer redacted as phone numbers.
- The agent hooks read glob bracket expressions as the shell does. A command with one that is not a valid regular expression (for example `[z-a]` or `[a\]`) no longer makes the hook fail, and a `]` as the first member or a POSIX class such as `[[:alpha:]]` is now understood, so words like `.e[!]]v` or `.en[[:alpha:]]` are recognised as naming `.env`.
- `zn audit` no longer reports zn's own `secrets` MCP server as an unknown server when its command ends with the `--agent <id>` that `zn hooks install` adds.
- `zn init` finds the Antigravity MCP settings: it checks `~/.gemini/antigravity/mcp_config.json` and `~/.gemini/config/mcp_config.json` (each one only if it exists). It looked for `~/.gemini/antigravity/mcp.json`, which Antigravity does not use, so Antigravity was never found.
- The threat model said that `zn run` keeps interpreter start-up variables such as `NODE_OPTIONS`; since 1.5.1 it removes them whenever it injects secret values.

### Security
- The agent hooks' check for zn admin commands no longer takes exponential time on a crafted `zn stats` command with many flags, which could stall the hook.
- `zn-gate scan --format github` (Python) escapes file names and messages in its `::error` and `::notice` lines, so a file name cannot add a line or a workflow command of its own to the CI log.
- Agent plugin launcher: JavaScript modules that Node loads by itself (zn-gate's encryption libraries) can only come from the verified zn-gate files, and are run from the bytes that were checked. This covers ES modules, CommonJS and JSON that Node loads, and the require() calls inside them. It needs Node.js 22.15 or 23.5 or later for the hooks; the MCP servers have it on every supported version (before Node.js 22.15 without createRequire(), which the release build refuses). Before, a module missing from the package could be looked up in node_modules folders outside it, and the source was read from disk again after the check.
- The Python package (`zn-gate` on PyPI) now redacts the same provider token formats as the Node.js scrubber: Stripe, Slack, GitLab, npm, PyPI, SendGrid, Google, Hugging Face, Twilio, AWS STS, Azure storage and AD secrets, DigitalOcean, Shopify, Mailgun, Groq, Replicate, xAI, Docker Hub, Tavily, Firecrawl, Polar, Supabase and other provider tokens, passwords in URLs, and `Authorization: Bearer` tokens. Generic assignments such as `password = "..."` in source files are not yet redacted by the Python package. Token-like runs of 24 or more characters that remain after redaction are masked in printed output and in the evidence ledger preview.
- `zn-gate scan --format github` prints the rule, the reason and the file and line only. It no longer prints the matched line, so CI logs do not show credential text.
- The evidence ledger directory is created with mode 0700 and the ledger file with mode 0600 on POSIX systems, in both the Node.js and the Python packages. A ledger that others can read is restricted on the next write.

## [1.6.0] - 2026-10-14

**If you use zn-gate 1.5.x, update.** In 1.5.x, `zn-gate scan` (Node.js) printed `PASSED` for a folder whose `.env` or other files held API keys, because it only reported prompt-injection text. 1.6.0 reports exposed credentials too (see 1.6.0-beta.1 below). After updating, run `zn-gate scan` again on your projects. This release also includes everything in 1.6.0-beta.1.

### Added
- Every rule layer has a version: `SCRUB_RULES_VERSION` (secret and PII patterns), `AUDIT_RULES_VERSION` (`zn audit` rules) and `POLICY_RULES_VERSION` (hook policy). `SCRUB_RULES_VERSION` is `2026-10-14.2`, `POLICY_RULES_VERSION` is `2026-10-14.4`, and `AUDIT_RULES_VERSION` is `2026-10-14.1`. `zn-gate --version` and `zn-gate status` show the scrub and audit versions next to the rules engine version.

### Changed
- Block and error messages now say what happened and what to do next, in plain words. The CLI prints the code (such as `ZN_LOCKED`) only with `ZN_VERBOSE=1` or `DEBUG` set, and the suggested commands (`zn unlock`, `zn secret set NAME`, `zn env shadow FILE`) fall back to `npx -y zn-gate@<version>` when `zn` is not on your PATH.
- Default policy by tiers. zn-gate still blocks what is almost certainly an attack or a leak: credential files, requests for secrets, exfiltration links, Base64 or invisible-character evasion, "ignore previous instructions", the narrow forms of the rules above and dangerous commands. Ten heuristic rules that also match ordinary text (`pi:identity_override`, `pi:system_tag`, `pi:system_bracket`, `pi:new_instructions`, `pi:pretend`, `pi:roleplay`, `pi:jailbreak`, `pi:bypass`, `pi:override`, `pi:template_boundary`) now give an advisory by default instead of a block. Strict mode blocks them as before: `ZN_STRICT=1`, `"strict": true` in `zn.config.json`, a `strict` line in `.znrules`, the `strict` option in Node.js or `evaluate(text, strict=True)` in Python. In our tests, benign texts blocked on a public prompt-injection dataset went from 8 of 7,150 to 0; injections blocked went from 24.0% to 22.4% and from 27.7% to 21.3% on two public datasets, and every injection that is no longer blocked gets an advisory. `zn-gate test` counts an advisory on an attack sample as detected and shows it as ADVISORY. `zn audit` and `zn-gate scan` keep reporting these patterns (they use strict mode). The Python `check_tool_call`, `check_tool_result` and `sanitize_tool_result` return the advisory and take `strict=True`. Strict mode set in the environment or a config file cannot be turned off by passing `strict: false`. `RULES_VERSION` is now `2026-10-14.3`.
- Fewer false blocks from the local rules. Four rules blocked a lot of ordinary text, such as documentation, code and requests like "act as a gateway". They now block only the clear form, and the broader match is reported as an advisory: the verdict stays `allow` and the result carries `advisory` with the rule and a short reason (`zn-gate analyze`, `analyze_prompt`, Python `evaluate()` and `analyze()`).
  - `exfil:credentials` blocks when a verb such as "send", "print" or "read" starts an instruction and a credential word ("API key", "password", "token", `.env`) follows in the same sentence, within 80 characters. Before, the two words could be anywhere in the text, so whole documents were blocked.
  - `indirect:hidden_tag` blocks when the instruction-like word is inside the hidden element. Before, any later word such as "system" counted.
  - `pi:act_as` blocks a request to the model to act as an assistant, a model, a persona or an unrestricted mode ("You will act as …"), not "act as a gateway".
  - `pi:forget` no longer blocks "forget all cached entries", "forget your password" and similar phrases about data.
  In our tests on 747 public files (package READMEs and code, docs), files blocked by the local rules went from 5.6% to 1.1%; on two public prompt-injection datasets, benign texts blocked went from 2.1% to 0.1%, injections blocked went from 28.1% to 24.0% and from 30.9% to 27.7%, and every injection that is no longer blocked gets an advisory. The local rules are a first layer; the cloud check (`ZN_CLOUD=1`) is unchanged. `RULES_VERSION` is now `2026-10-14.2`.
- CI fails when the local rules block more benign text. A new gate runs the rules engine over the pinned benign corpus and over a list of ordinary developer sentences, and compares the block counts per rule with a committed baseline.
- CI also fails when a rule layer changes without a higher version, or when its rule ids change without an updated snapshot. When the block counts fall, the gate passes and warns that its baseline is stale.

### Fixed
- `zn unlock` no longer hangs at "Repeat passphrase" when the second line arrives before its prompt (for example when both lines are pasted at once). Each prompt used its own line reader and the second line was lost, so the vault was never created and `zn env shadow` then reported that the vault was locked. Wait for each prompt before typing: text typed before a prompt appears can be shown on screen by the terminal. Different passphrases, Ctrl+C and Ctrl+D now end with a clear message instead of waiting.

### Security
- Agent hooks: an AI agent could run the zn commands that manage your secrets and protection (`zn unlock`, `zn lock`, `zn secret ...`, `zn env shadow|unshadow`, `zn hooks install|uninstall`) by calling a specific package version, for example `npx -y zn-gate@1.5.1 hooks uninstall` or `npm exec zn-gate@1.5.1 -- unlock`: the hook only recognised the plain `zn` and `zn-gate` names. Most of these commands also refuse to run without an interactive terminal or when they detect a coding agent, which stopped the usual agents; `zn lock` had no such check. The hooks now deny the versioned forms with `npx`, `npm exec`, `pnpm dlx`, `yarn dlx` and `bunx`. Affected: 1.5.0-beta.1 to 1.6.0-beta.1.
- Trigger words are now found in the same way in Node.js and Python. A non-ASCII letter next to a trigger word (for example `éjailbreak`) no longer hides it: Python previously allowed this while Node.js blocked it, and both now block.
- Compatibility characters are folded before matching: fullwidth Latin text such as `ｉｇｎｏｒｅ` is treated as `ignore`, in both languages. The folding is used only for detection; the text returned to you is not changed.
- Invisible characters (zero-width spaces and joiners, the word joiner, variation selectors and Unicode tag characters) are ignored when matching, so a trigger word or a secret split by them is still detected.
- The dotless i (`ı`) and the capital dotted I (`İ`) are read as `i` and `I` when matching, so trigger words spelled with them are detected in both languages.
- A secret that contains invisible characters is redacted as a whole, including those characters. Before, a key such as `AKIA` followed by a zero-width space was not redacted.
- The Node.js scrubber finds such secrets too and reports their full span.
- The PII & secret scrubber now recognizes more credential formats: Docker Hub personal and organization access tokens (`dckr_pat_`, `dckr_oat_`), Tavily keys (`tvly-`), Firecrawl keys (`fc-`), Polar tokens (`polar_oat_`, `polar_pat_`, `polar_at_u_`, `polar_at_o_`, `polar_rt_u_`, `polar_rt_o_`, `polar_ci_`, `polar_cs_`), Replicate tokens (`r8_`, 40 characters), Supabase personal access tokens (`sbp_`) and Azure AD client secrets.
- Coverage fixes: Hugging Face tokens made only of letters, Stripe `sk_prod_` keys, Twilio API key SIDs in upper case, and legacy 32-character hexadecimal `sk-` keys are now detected by the scrubber as well.

## [1.6.0-beta.1] - 2026-10-14

Pre-release for testing. Install it with `npm install -g zn-gate@beta` or `pip install --pre zn-gate`. The agent plugin in `plugins/zn-gate` is not published with this beta; it ships with 1.6.0.

### Added
- Cloud checks of long texts (`analyze_prompt`, `zn-gate analyze`, Python `analyze()`, only with `ZN_CLOUD=1` and a key): a text over 1,000 characters asks the classifier for overlapping 512-token windows (stride 256, up to 20) instead of reading only the first 512 tokens; the verdict comes from the window with the highest score, and a text that fits in one window gets the same result as before. In our internal tests (long documents with one hidden injection; results depend on the text), detection went from about 1% to 91% when it was in the middle and to 86% at the end; false positives on long benign documents went from 3.7% to 5.7%, and long texts take about three times as long (the client allows 12 s instead of 4 s). Cloud checks are billed by text size, with or without windows (`off` does not lower the count): 1 call up to 2,000 characters, and 1 more for each further 1,000 characters or part of them (up to 19 calls for the 20,000-character limit); the gate reports the count in `billed_calls`. When more windows would be needed, or the gate falls back to checking only the first 512 tokens, the result carries a `warning`. Turn it off with `ZN_LONG_INPUT=off`, `--long-input off` or `long_input="off"`. Needs a cloud gate that supports `long_input`; an older one ignores the field.
- `zn audit [path]` (also `zn-gate audit`) reviews the agent configuration a repository ships before you open it, without running anything: hooks and other commands that run automatically, project MCP servers, unpinned packages, model endpoint and proxy overrides, code-loading environment variables, credential helpers, broad permissions, secrets, dangerous instructions in `AGENTS.md`, `CLAUDE.md` and similar files, agent extensions, executables in the root that shadow common tools, and CI workflows that run an agent on untrusted input. It covers Claude Code, Codex, Cursor, OpenCode, Amazon Q, Copilot and Gemini CLI. Output as text, JSON or SARIF 2.1.0 (GitHub code scanning); `--fail-on` sets the exit code. Rules `ZNA001`-`ZNA020` and the public vulnerabilities behind them: [docs/audit.md](docs/audit.md). The secret-use log that `zn audit` showed in 1.5 is `zn vault log` (alias `zn secret log`); `zn audit log` and `zn audit --since` exit with code 2 and point there.
- **zn Team client** (`zn team join | status | sync | leave`): connects this machine to a zn
  organization ([docs/team.md](docs/team.md)). The organization's policy is signed with Ed25519
  and checked against the key pinned at join time (also its organization, version, expiry and
  issue date, with five minutes of clock tolerance); the accepted policy is kept in the encrypted
  vault. The `secrets` MCP server and `zn run` apply it. The organization can always restrict a
  secret (`deny`, fewer hosts or commands, `proxy` mode, where the value may go in a request) and
  add custom secret formats for the scrubber; a new host for a secret applies only after the user
  approves it once on this machine; it can never open a new command, mode or placement, or reach
  the protections for credential files, `~/.zn` or agent configuration. Every matching rule
  restricts every agent, because zn-gate cannot prove which agent is calling; a rule's agent list
  only decides who can be offered a new host. When the policy expires while offline, only its restrictions keep applying. The
  audit log (metadata only, never values) is uploaded in batches that resume from the last record
  the server confirmed. Join and leave are confirmed on the vault's own channel, outside the agent.
- `zn hooks install` now starts the `secrets` MCP server with `--agent <id>` for Claude Code, Codex,
  Cursor and OpenCode.
- `zn vault log export --otlp [--since 7d] [--out FILE]`: the local audit log as OpenTelemetry logs
  (OTLP/JSON Lines, one `ExportLogsServiceRequest` per line) for an OpenTelemetry Collector, with
  no account.
- **Agent plugins** (`plugins/zn-gate`): one package in the Agent Plugins 1.0 format that
  connects Claude Code and Cursor to zn-gate (hooks, the `zn-gate` and `secrets` MCP servers and
  a skill), and gives Codex the MCP servers and the skill (Codex does not run plugin hooks; use
  `zn hooks install codex`). In Claude Code, zn-gate is installed with the plugin from its
  `package-lock.json`; other agents use the copy you installed. On every call it requires
  the exact pinned version, checks that the package holds exactly the files of the published
  release, runs zn-gate from the checked bytes and fails closed otherwise. Marketplace files
  for Claude Code, Codex and Cursor, and an MCP Registry entry (`plugins/mcp-registry/server.json`,
  `mcpName` in package.json). Needs Node.js 20.12 or later.

### Changed
- Cloud checks (`ZN_CLOUD=1`) are billed by text size, for every request and with or without windows: 1 call up to 2,000 characters, and 1 more for each further 1,000 characters or part of them, up to 19 calls for the 20,000-character limit. Before, every check counted as 1 call. Requests up to 2,000 characters are billed as before. The count comes back in `billed_calls` and counts toward your plan's quota.
- The project now documents how it is run: [GOVERNANCE.md](GOVERNANCE.md) (decisions, releases, contributions, new maintainers), [MAINTAINERS.md](MAINTAINERS.md) and an updated [SECURITY.md](SECURITY.md) (supported versions, how to report a vulnerability, response times and coordinated disclosure).
- GitHub Action (`action.yml`): `actions/setup-python` is now v7, which runs on Node.js 24. Self-hosted runners need runner version 2.327.1 or later; GitHub-hosted runners already have it.
- The `usezn` plugin marketplace in this repository now lists the agent plugin in `plugins/zn-gate`, which replaces the Claude Code plugin shipped with 1.5.x (`plugins/claude/zn-gate`). In Claude Code it still installs zn-gate itself: Claude Code installs the release pinned by the plugin's `package-lock.json` into the plugin folder, and the launcher checks that copy file by file against the published release before running it; other agents use a copy you install (`npm install -g zn-gate@1.6.0`, once 1.6.0 is released; the plugin is not part of this beta). It keeps both MCP servers of the 1.5.x plugin, `zn-gate` (`analyze_prompt`, `check_tool_call`, `check_tool_result`, `zn_status`) and `secrets`, and starts the `zn-gate` one with local rules only; its skill is now `zn-secrets`. To upgrade in Claude Code, update the marketplace and the plugin (`claude plugin marketplace update usezn`, then `claude plugin update zn-gate@usezn`) and start a new session. `plugins/tools/pin-release.js` now also writes the plugin's `package.json` and `package-lock.json`.

### Security
- Prompt hooks (all agents) block a prompt that assigns a value to a credential name anywhere in the text, also in the middle of a sentence and even when the value does not look random: `my key is STRIPE_KEY=...`, `DB_PASSWORD=...`, `"api_key": "..."`, `apiKey=...`, `?api_key=...` in a URL. The value must be at least 8 characters. Left alone: placeholders and demo values (`changeme123`, `your_api_key_here`, `<key>`, `xxxx`, `dummy…`, `mock…`), references (`${API_KEY}`, `$API_KEY`, `process.env.X`, `secrets.X`, `__ZN_…__` markers), code (calls, indexes, type annotations, identifier chains such as `self.api_key` or `new_password`) and lower-case prose such as `token: required`. The block message still suggests `zn secret set NAME`. Tool calls and tool output do not use this rule. The Python package has no prompt hook, so it is not affected.
- `zn hooks install claude-code` and the Claude Code plugin set `onFailure: "block"` on the prompt hook, so a prompt is blocked, not sent unchecked, if the hook cannot start or times out (Claude Code 2.1.295 and later; earlier versions ignore the field). Tool hooks keep the documented behaviour. [docs/compat.md](docs/compat.md) now lists what each agent does when the zn hook cannot run.
- `zn-gate scan` (Node and Python) reports a private key that has a BEGIN marker but no END marker (cut short when pasted or truncated), and never prints its lines: the lines after the marker that look like base64 or PEM headers count as key material, up to the first empty or other line (the empty line after the `Proc-Type` / `DEK-Info` headers of an encrypted key is kept). Both scanners now also scan private key files without an extension (`id_rsa`, `id_ed25519`…), and skip `.key` files with a NUL byte in the first 8 KiB (a Keynote document, not a key). The Python scanner matches extensions regardless of case (`SERVER.PEM`) and, like the Node one, skips files of 2 MiB or more.
- `zn-gate scan` (Node and Python) never prints a line that is inside a private key spanning several lines, even when another rule fires on that line (for example injection text next to key material); such lines show `[REDACTED_PRIVATE_KEY]`. `.pem` and `.key` files are now scanned. The printed BEGIN marker is cut to 100 characters.
- Node `zn-gate scan` now reports exposed credentials, as the Python scanner does: before, it reported only lines the injection rules blocked, so a file with an API key or a private key passed. Each secret is reported once per rule and line with the line redacted, and a private key whose BEGIN and END markers are on different lines is reported at its BEGIN line, showing only that marker. Files that contain credentials now make the scan exit with code 1.
- Python `zn-gate scan` reports a private key whose `-----BEGIN ... PRIVATE KEY-----` and `-----END ... PRIVATE KEY-----` lines are on different lines, as PEM files always have them. The scan read one line at a time, so these keys were never reported. Only the `-----BEGIN ... PRIVATE KEY-----` marker is shown, never the key.
- Windows: looking up a program on PATH (for `zn run` and to find agent CLIs) uses a name as written only when it already has a PATHEXT extension, as Windows does: an npm install puts an extensionless shell script `claude` beside `claude.cmd`, and zn picked the script, which Windows cannot run. When `zn hooks install claude-code` cannot register the `secrets` MCP server itself, it now prints `claude mcp add --scope user secrets -- "<node>" "<cli.js>" ...`, which works in cmd.exe, PowerShell and POSIX shells.
- Secret redaction covers credentials assigned to environment-style names with a prefix: `OPENAI_API_KEY=…`, `STRIPE_SECRET_KEY: …`, `"DB_PASSWORD": "…"`, `ENV HF_TOKEN …` in a Dockerfile and `$OPENAI_API_KEY = '…';` in PHP or PowerShell (new rule `secret:prefixed_credential`: upper-case names ending in `API_KEY`, `APIKEY`, `ACCESS_KEY`, `SECRET_ACCESS_KEY`, `SECRET_KEY`, `PRIVATE_KEY`, `CREDENTIALS`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PASS` or `PWD`). The names already covered by `secret:env_credential` (`API_KEY`, `SECRET_KEY`, `AUTH_TOKEN`…) are now also found as quoted JSON keys (`"api_key": "…"`). The value of these assignments is checked before it is redacted. Left alone: references (`${VAR}`, `$VAR`, `$env:VAR`, `%VAR%`, paths, file names such as `service-account.json`, host names, URLs without a password, `op://` and other `scheme://` references, ARNs, `vault:`, `secretref:`, Azure Key Vault and Google Secret Manager references), code (`process.env.X`, `os.environ[...]`, `settings.X`, `std::env::var(...)`, `$this->config->get(...)`, `z.string()`, other calls, indexes and identifier chains, constant names), placeholders that are the whole value (`<your-key>`, `{{ … }}`, `****`), placeholder words (`your-key-here`, `changeme`, `fake-…`, `mock-…`, `__ZN_…__` vault markers) and short lower-case slugs that name an object (`regcred-ghcr`, `ingress-nginx-tls` under `*_SECRET`). A value that looks machine-generated is redacted even when it contains a placeholder mark (`<…>`, `${`, `{{`, `***`, `...`, or starts with `<`, `{` or `[`, as passwords from a password manager can) or has the shape of code or a path, such as a Mapbox `sk.eyJ…` or SendGrid `SG.….…` key or a base64 key that starts with `/`; a URL with a password in it is redacted too. `$NAME = …` counts as an assignment; `$NAME:` and `${NAME}` are references. The default in `${NAME:-value}` is redacted only when it looks machine-generated (new rule `secret:credential_default`). The checks read up to 32 K characters of values per call; past that, matches are redacted without them, which bounds the time spent on crafted input (more is redacted, never less). Node.js now counts the 12-character minimum of these rules in characters, as Python does, so an emoji counts once. Because more credential lines are found, the Python `zn-gate scan`, which reports secrets, can exit with code 1 on files it used to pass. `RULES_VERSION` is now `2026-10-12.6`.

### Known limitations
- The agent plugin (`plugins/zn-gate`) checks every file of the installed zn-gate on each hook call, on top of the cost of the hook itself: a median of 15 to 27 ms per call on Linux and macOS and 51 to 90 ms on Windows in CI (`plugins/tools/bench-launch.js`). It needs Node.js 20.12 or later and refuses to run when `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, an experimental Node.js API, is missing.
- Credentials under environment-style names are not redacted when the name is lower case or camelCase (`db_password:`, `apiKey =`), when the value is shorter than 12 characters, or when the value is lower-case words joined by `_` (read as an identifier). Lower-case words joined by `-` or `.` are redacted as a passphrase, except when they read as a name: two words (`regcred-ghcr`); three words with a short word or a number (`ingress-nginx-tls`); three words under a `*_SECRET` or `*_CREDENTIALS` name (`JWT_SECRET=orbit-maple-harbor` is not redacted); a host name or a file name (`smtp.example.com`, `service-account.json`); or words that give an instruction (`ask-the-ops-team`, `get-from-vault`).

## [1.5.1] - 2026-10-13

Security release, mainly for Windows. Update with `npm install -g zn-gate@1.5.1`. The Python package has no code changes in this release.

### Security
- **Windows: `zn run` starts batch files through the system cmd.exe only.** For a `.cmd` or `.bat` program (for example an npm-installed CLI), the program that received the secret values could be chosen through the caller's environment. zn run now starts the system's cmd.exe, found through the system itself rather than any environment variable (`/d /v:off /s /c`, arguments passed verbatim), refuses to run the batch file if it cannot find it, and refuses a program path containing `%`, `!` or `"`, which cmd.exe would expand.
- `zn run` removes interpreter start-up variables (`NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `BASH_ENV`, `ENV` and similar) from the environment of an approved program when it hands over secret values, as it already did for dynamic loader variables. On Windows it also sets `NoDefaultCurrentDirectoryInExePath=1` for that program, so the programs it starts by name are not taken from the current directory.
- Windows: the OpenCode plugin written by `zn hooks install opencode --project` starts `zn` with `NoDefaultCurrentDirectoryInExePath=1`, so cmd.exe does not run a `zn.cmd` planted in the project directory instead of the installed zn.
- `zn hooks install claude-code` no longer runs a batch-file `claude` (an npm install on Windows) through cmd.exe to register the `secrets` MCP server; it prints the command to run instead (and `claude mcp remove` on uninstall).
- An API key that cannot be a zn key (anything but 16 to 256 letters, digits, `_`, `-` and `.`, such as a blank value or a placeholder a launcher left unexpanded) now counts as unset, so `ZN_CLOUD=1` with such a value keeps prompt analysis local.

### Known limitations
- Approving a batch file (`.cmd`, `.bat`) for a secret in `zn run` approves that file, not the programs it starts by name: an npm shim runs the `node` found on the caller's `PATH`. Prefer `secrets_http_request` for HTTP APIs, or approve the program itself.

## [1.5.0] - 2026-10-12

Secrets scrubber and broker: secret values stay out of what your coding agent
sends to its model. Walkthrough: [docs/secrets.md](docs/secrets.md).
Limits: [docs/threat-model.md](docs/threat-model.md). Per-agent support:
[docs/compat.md](docs/compat.md).

### Added
- **Scrubber engine** (`lib/scrub/`), 100 % local, in three layers:
  - known values from the vault and from local `.env` files;
  - about 30 secret formats (cloud keys, tokens, private keys, connection-string passwords);
  - PII with checksum validation (cards, IBAN, DNI/NIE, SSN; e-mail, phone, IPv4).
  Values become deterministic tokens such as `__ZN_AWS_KEY_1__`. Gated in CI by the leak bench: 0 leaks, at most 0.1 % of benign files changed.
- **Encrypted local vault** (`zn unlock` / `zn lock`, `lib/vault/`):
  - [age](https://age-encryption.org) encryption, with the identity in the OS keychain (macOS, Windows, Secret Service) or behind a passphrase;
  - a short-lived daemon on a private socket or pipe, with mutual authentication;
  - an HMAC-chained audit log that holds no values (`zn vault log`, `zn vault verify`).
- **Secrets broker**:
  - `zn secret set|list|rm|allow|approve|import|adopt` and `zn env shadow|unshadow` (move `.env` values into the vault and leave markers);
  - `zn run -- <command>` fills values only into allowed commands and masks their output;
  - the `secrets` MCP server (`secrets_http_request`, `secrets_render_file`, `secrets_request`), which has no tool that returns a value.
- **Agent hooks**: `zn hooks install claude-code|codex|cursor|opencode`.
  - They block reads of `.env` files with values, credential files and `~/.zn`.
  - They scrub tool output and block pasted secrets.
  - They route commands that use stored secrets through `zn run`.
  - What each agent allows differs: see `docs/compat.md`.
  - Claude Code coverage includes Bash, PowerShell, Monitor (through a streaming filter), Read, Grep, LSP, WebFetch, MCP tools and MCP resources.
- **Out-of-band confirmation**: the first use of a secret by a command, and any change that widens a secret's policy, are confirmed in the vault's own terminal (`zn unlock --foreground`) or a system dialog. They are never confirmed in the agent's terminal.
- End-to-end runs with Claude Code, Codex and OpenCode against a scripted provider, with 0 values sent (`bench/e2e/`). Hook latency figures are in `bench/HOOK_LATENCY.md`.
- MCP Registry metadata: `package.json` declares `mcpName` (`io.github.usezn/zn-gate`) and `packages/zn-gate/server.json` describes the `zn-gate mcp` server (stdio) and its optional environment variables.

### Changed
- The vault audit log is now shown with `zn vault log` (alias `zn secret log`), next to `zn vault verify`; the output and exit codes are unchanged. `zn audit` still shows the log in 1.5 and prints a one-line notice on stderr; in 1.6 `zn audit` will become the audit of your configuration only.
- GitHub Action: installs the published `zn-gate` package from PyPI at the exact `version` (now `1.4.1` by default) as a wheel, with no dependencies, into a private virtualenv, instead of building the package from the action's own checkout. Versions that are not exact (ranges, `latest`) are refused, inputs reach the scripts only through environment variables, `actions/setup-python` is pinned to a commit SHA, and a new optional `package-sha256` input checks the wheel's hash. The other inputs, their defaults and the exit behaviour are unchanged. Two differences: zn-gate is no longer installed into the job's Python, so a later step that runs `zn-gate` or imports `zn_gate` must install it itself; and versions that are not exact, such as `1.4`, are now refused instead of being resolved by pip. A new `scan-exit-code` output gives the scan's exit code. A self-test workflow runs the action from the checkout on Linux, Windows and macOS.
- The npm package no longer ships the test suite (`test/`); run the tests from the repository. `zn-gate test` (the built-in self-test) is unchanged.
- The npm package now includes `THIRD_PARTY_NOTICES.md` with the licenses of the bundled `age-encryption`, `@noble` and `@scure` packages.
- CI packs the npm tarball, checks its contents, installs it in an empty project and runs the CLI from it; it also builds the Python sdist and wheel, runs `twine check` and installs the wheel in a clean virtualenv. Every supported Node.js version (18, 20, 22, 24) runs the full `npm test`.

### Fixed
- Python CLI: `zn-gate scan`, `test`, `evidence` and `status` no longer crash with `UnicodeEncodeError` on consoles with a legacy code page such as Windows cp1252. Symbols the console cannot encode are printed as plain markers (`[+]`, `[!]`, `[ok]`) and other characters are replaced; output on UTF-8 terminals is unchanged.
- `zn vault log` (formerly `zn audit`) no longer fails with a Node.js error after listing the log: the chain is checked through the unlocked vault, as `zn vault verify` does (exit code 1 when the chain is broken), and a locked or missing vault is reported instead.

### Security
- Scrubber: secrets without a known prefix are now caught under a sensitive key name in YAML without quotes, docker-compose `environment:` (map and `- KEY=value` list), dotenv and Dockerfile `ENV` / `ARG` lines, and `docker run -e`, including hex values of 32 digits or more. Commit hashes, colors, UUIDs and digests in other fields, placeholders and references (`${VAR}`, `$VAR`, `${{ … }}`) are left alone.
- `secrets_http_request` puts a value only in request headers unless the secret allows the URL or the body (`zn secret allow NAME --in query|body`).
- First-use approvals are bound to the executable's real path and file identity. A replaced or retargeted binary loses its approval. Binaries inside the project never receive values.
- The vault file carries an integrity tag. A forged, corrupted or deleted vault fails closed.
- `zn run` resolves the command once, opens that file, checks the open file against the approval, checks it again right before start and starts that exact path; on Linux a native program is started through the opened file itself. The approval dialog and `zn secret allow` warn when the program lives in a location your user can write. If an approved program changed, the dialog says so, with the old and new size and change time.
- Interpreters are recognised with version suffixes (`python3.12`, `node22`, `pwsh-preview`) for the "runs any code" warning.
- Claude Code Monitor commands always run as a single `bash -c` argument piped through the streaming scrubber, with `pipefail`. The streaming scrubber holds back the end of a partial line, so a value written in two bursts is never split.
- Paths in hook commands and in the commands the hooks rewrite (the `zn run` prefix of Bash commands, the Monitor scrubber pipe) are single-quoted for sh, and PowerShell-quoted where PowerShell runs them (the PowerShell tool rewrite, Codex `commandWindows`), so an install path containing `$(…)` or backticks can no longer run commands. A quote in a path is written as `'"'"'`, which also keeps it inside a string when PowerShell reads an sh command (Claude Code hooks without Git Bash, the OpenCode bash tool on Windows). On Windows, Codex `commandWindows` and Cursor hooks call `powershell.exe` in a form that cmd.exe, PowerShell and Git Bash leave unchanged (`-EncodedCommand` when a path holds `%`, `!`, `$`, a backtick, a quote or a control character). Hooks installed by earlier versions are still recognised by `zn hooks install` and `zn hooks uninstall`.
- A missing scrubber engine fails closed by default, with instructions to reinstall; `{"hooks": {"whenUnavailable": "allow"}}` in `~/.zn/config.json` lets events pass while it is missing.
- `secrets_render_file` writes a new file inside the project directly; overwriting a file or writing outside the project (also through a symlinked directory) needs your confirmation in the vault prompt.
- Confirmation dialogs show warnings first; paths and other fields sent by a client are shown on one line, with control and invisible characters escaped.
- `age-encryption` and its `@noble` / `@scure` dependencies are bundled in the npm package at the exact versions of the lockfile (`bundleDependencies`), so installing zn-gate does not resolve them from the registry.
- Rules engine (Node.js and Python): removed super-linear regular expressions and normalization steps that let a crafted input of a few KB to a few hundred KB stall the gate for seconds to minutes (newline rejoining, fake system tags, hidden HTML elements, markdown image exfiltration, JWT redaction, Russian and Chinese rules). Hidden elements, markdown images and the Russian and Chinese rules are now matched by a single linear scan plus checks in code, which also removes the length caps on tag attributes, image alt text and URLs. For hidden elements and markdown images, the exported `.pattern` is the linear scanner the rule uses, not the full rule; the Russian and Chinese rules keep a bounded reference `.pattern` and match with a linear scan in code. Inputs over 8 KB no longer enter the result cache. The Python rules use the same patterns, normalization and size limits as the Node.js rules, and a test fails if the two diverge.
- Inputs over 256 KB: `evaluate()` / `analyze` analyse the first 192 KB and the last 64 KB and mark the result `truncated: true`. Tool results are scanned in full in overlapping 256 KB windows up to 4 MB: `sanitizeToolResult` and `checkToolResult` (and through them the MCP tool `check_tool_result` and `shield`) in Node.js, `sanitize_tool_result` and `check_tool_result` in Python. `sanitizeToolResult`, `checkToolResult` and `sanitize_tool_result` return a top-level `truncated` field (Python `check_tool_result` sets `Assessment.truncated`); set `blockTruncated: true` (Node.js), `block_truncated=True` (Python `sanitize_tool_result`, `check_tool_result` and `@guard(check_result=True)`) or `ZN_BLOCK_TRUNCATED=1` (both, including `@guard(check_result=True)` and the LangChain integration) to block output that could not be scanned in full.
- `ignore` / `disregard` rules now require an object: instructions, prompts, rules, guidelines, directives, guardrails, context and similar, with a qualifier (previous, prior, above, earlier, original, system, safety...) or a quantifier (all, any, every, your, these, those...), or a reference back to earlier text ("ignore the above.", "everything above"). Sentences like "Please ignore the noise in the logs" or "ignore the previous build output" are no longer blocked. A new rule covers the Portuguese and Spanish imperative ("ignore todas as instruções", "ignora todas las reglas"). Node.js and Python.
- The evidence dashboard (`zn-gate evidence --ui`) listens on 127.0.0.1 only, answers only requests whose `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (other hosts get 403, which blocks DNS rebinding), and escapes every ledger field shown in the dashboard.
- `zn-gate scan` no longer prints detected secrets: the line shown for each finding is redacted first (Node.js and Python, including `--format github` annotations and JSON output in Python).
- Secret detection in Python no longer misses a key written right next to a non-ASCII letter (for example `cléAKIA…`): secret patterns use explicit ASCII token boundaries, as the Node.js rules already did. `RULES_VERSION` is now `2026-10-12.1`.
- The OpenAI key pattern covers OpenRouter (`sk-or-v1-`), Langfuse (`sk-lf-`) and admin keys, and no longer matches hyphenated text such as URL slugs (a key without a known prefix must be at least 28 letters and digits). Private-key redaction no longer slows down on text with many `BEGIN ... PRIVATE KEY` headers and no end marker. Node.js and Python now redact `aws_secret` values the same way, keeping the original quotes, and Python matches credential names with ASCII letters only, as Node.js does (the Kelvin sign or a long s no longer count as `K` or `s`). Python, like Node.js, also finds `aws_secret` values under names with a prefix such as `MY_AWS_SECRET=`. A key without a known prefix is still found when it is followed by `_` (`sk-…_backup`). Python matches connection-string schemes (`postgres://`, `mysql://`, `mongodb+srv://`, `redis://`, `amqp://`) with ASCII letters only, like Node.js, so `poſtgres://` is no longer treated as `postgres://`; `RULES_VERSION` is now `2026-10-12.4`.
- The OpenAI key pattern also finds Helicone keys (`sk-helicone-…` with its `eu`, `cp`, `gov` and `rl` variants, also when followed by `-`, `_` or an uppercase letter), the Helicone forms without the word `helicone` (`sk-cp-…`, `sk-xxxxxxx-xxxxxxx-xxxxxxx-xxxxxxx`; these must contain a digit, and are left alone when followed by `-` and a letter or digit, which reads as a longer slug), Alibaba Cloud Model Studio Token Plan and Coding Plan keys (`sk-sp-` followed by 28 or more letters and digits; the body format is not documented, so this length is an assumption), and OpenAI keys with any other `sk-<name>-` prefix that carry OpenAI's `T3BlbkFJ` marker, such as older service-account keys. Hyphenated text such as URL slugs is still not matched, and keys matched before keep the same redacted span. `RULES_VERSION` is now `2026-10-12.5`.
- Releases are built once by a tag-triggered workflow and published to npm and PyPI with trusted publishing (OpenID Connect, no stored tokens), after a manual approval. Each release ships `SHA256SUMS`, Sigstore bundles and GitHub build provenance attestations; npm and PyPI carry provenance too. Prereleases go to the npm dist-tags `beta`, `next` (release candidates) or `alpha` and never move `latest`. 1.5.0-beta.1 and earlier versions are not signed. How to check them: [docs/verify-release.md](docs/verify-release.md).

### Known limitations
- Detection of credentials under prefixed variable names (e.g. OPENAI_API_KEY=) is partial in this release.
- Cursor cannot rewrite the output of shell commands or file reads. Codex can only replace output through "block", and keeps the original in its own session log.
- Each hook is a short Node process: measured about 78 ms p50 per tool call on a Windows desktop and 124 ms on a small server (`bench/HOOK_LATENCY.md`). The floor is Node's start-up; scanning inside the vault daemon would remove most of it and is planned for a later release, with its own review.
- With the vault unlocked, any process of your OS user can ask the vault daemon for a stored secret by name. Approvals, fingerprints and `allowIn` protect the `zn run` and MCP paths, not that one (see `docs/threat-model.md`).
- Scripts (`#!`) approved for `zn run`, and every program on macOS and Windows, are started by path right after the final check: a process of your user that can write the program's directory could still swap it in that short window. Prefer approving native programs in directories your user cannot write.
- Not covered yet: Hermes, Gemini CLI, Copilot CLI and the Cursor CLI. An egress proxy for `zn run` is not included.
- Rules engine size limits: prompts over 256 KB are analysed as head + tail, so a payload in the middle is not seen (the result says `truncated: true`). Tool results over 4 MB are analysed in full up to 4 MB plus their last 256 KB, and are allowed with `truncated: true` unless blocking is enabled (see Security). Tool-result windows overlap by 4 KB, so a hidden HTML element whose payload starts more than 4 KB after the tag, across a window boundary, can be missed.

## [1.4.1] - 2026-10-11

### Security
- **1.4.0: with `ZN_API_KEY` set, tool results and tool-call arguments were sent to api.usezn.com for analysis without redaction. 1.4.1 removes that path entirely; cloud analysis is now opt-in (`ZN_CLOUD=1`), prompt-only and redacted.**
  - Affected: the Node package (`zn-gate` on npm) up to and including 1.4.0, when `ZN_API_KEY` was set and `ZN_LOCAL_ONLY` was not `true`. Inputs blocked by the local rules were never sent. Without `ZN_API_KEY` nothing was sent.
  - Paths that sent data in 1.4.0: the MCP tools `check_tool_result`, `check_tool_call` and `analyze_prompt`, the `zn-gate shield` proxy (tool arguments, tool/parameter descriptions and tool results), `zn-gate analyze` and `zn-gate test`.
  - Python (`zn-gate` on PyPI) up to 1.4.0: only `analyze()` and `zn-gate analyze` sent data, when `ZN_API_KEY` was set, without redaction. `guard`, `check_tool_*`, `sanitize_tool_result` and the integrations were always local.
  - Recommended action: upgrade to 1.4.1. If you used 1.4.0 with `ZN_API_KEY`, consider rotating any credential that could have appeared in tool output.

### Changed
- **Tool results, tool-call arguments and tool descriptions are evaluated only locally**, under every configuration (MCP server, `shield`, library API).
- **Cloud analysis is opt-in:** it requires both `ZN_API_KEY` and `ZN_CLOUD=1`, applies only to prompt analysis (`analyze_prompt`, `zn-gate analyze`, `analyze()`), and the text is passed through `redactSecrets` / `redact_secrets` before sending. `ZN_LOCAL_ONLY=true` still overrides everything.
- **Secret redaction now runs on the real code path:** `check_tool_result` always returns content passed through `sanitizeToolResult`; `check_tool_call` returns `sanitized_arguments`; `shield` forwards allowed tool output with secrets redacted (not in `--shadow` mode). In 1.4.0 these functions existed but no executable path called them.
- The local audit log stores a secret-redacted `payload_preview` (the SHA-256 is still computed over the original payload).
- `zn_status` and `zn-gate status` report what leaves the machine. Removed the "Set ZN_API_KEY for neural protection" tip.
- `zn-gate test` (self-test) never uses the network.

### Fixed
- Python CLI: `zn-gate test` printed `BLOCK` when the verdict was `allow` and only the secret detector had fired. It now prints the real verdict and the DLP alert on its own line. The exit code is unchanged: 1 whenever something was flagged (a block or a secret).
- `zn-gate init` config locations and formats, verified against the official docs:
  - **Codex CLI:** `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), `[mcp_servers.<name>]` TOML tables. 1.4.0 wrote to a non-existent `~/.codex/config.json`.
  - **OpenCode:** `~/.config/opencode/opencode.json` (`mcp` key, `command` array, `type: "local"`). 1.4.0 used `~/.local/share/opencode/mcp.json`.
  - **Claude Desktop on Linux:** `~/.config/Claude/` (1.4.0 used `~/config/Claude/`, missing the dot).
  - Files that cannot be rewritten safely (JSONC with comments, multi-line TOML arrays) are reported as "wrap manually" instead of being modified.

### Documentation
- Removed figures without a public method (fixed "< 0.1 ms" style latency claims, "99.4 % accuracy", the comparison table against other guardrails, "100 % defense rate"). Added a single latency table with hardware, date and `bench/bench_by_size.js` to reproduce it.
- "Cryptographic / tamper-evident ledger" reworded: it is a hash-chained local log that detects accidental edits, not tamper-proof against someone with write access.
- Added "What leaves your machine" to all READMEs.
- Rewrote the GitHub, npm and PyPI READMEs around one path: what it is, one-command install per agent, a reproducible redaction check, what Scrubber / Galvanize / Scan do today (roadmap marked separately), data flow, measured numbers only, configuration, FAQ, security. Badges limited to CI, version and license.
- Documented a known limitation: false positives on whole source files in `check_tool_result` (not fixed in this release).

---

## [1.4.0] - 2026-09-29

### Added
- **Static Workspace & Prompt Security Scanner (`zn-gate scan <path>`)**:
  - Recursively audits prompt templates, markdown guides (`AGENTS.md`, `SKILL.md`), and configuration files for injection traps, covert beacons, and secret leaks.
  - Zero-configuration exit codes (`0` clean, `1` threats found) for seamless integration with git pre-commit hooks and CI/CD pipelines.
- **Trojan Source & BiDi Override Defense (CVE-2021-42574)**:
  - Detects and neutralizes Unicode Bidirectional override characters (`\u202A-\u202E`, `\u2066-\u2069`) across Node.js and Python engines.
- **Hidden CSS Injection Defense**:
  - Intercepts and neutralizes third-party tool outputs containing invisible CSS text (`display: none`, `opacity: 0`, `font-size: 0px`, `color: transparent`, `text-indent: -9999px`).
- **Multilingual Prompt Injection (German)**:
  - Added native detection rules for German prompt injection attempts (`pi:multi_de`) across Node.js and Python.
- **Expanded Self-Test Suite (51 Vectors)**:
  - Evaluates 26 attack patterns and 25 diverse benign developer scenarios (React, Next.js, TypeScript, Python, Rust, Docker, SQL, GraphQL, AWS CLI) with 100% accuracy and 0 false positives.

### Changed
- Migrated primary repository to official organization: **https://github.com/usezn/zn**.
- Synchronized rules engine to `RULES_VERSION: 2026-09-29.1`.

---

## [1.3.0] - 2026-09-06

### Added
- **1-Click MCP Auto-Shielding (`zn-gate init`)**:
  - Auto-discovers and wraps active MCP configurations across 7 leading AI agent environments: **Claude Desktop**, **Claude Code**, **Cursor**, **Antigravity**, **Codex**, **OpenCode**, and **Goose / Cline**.
  - Safe in-place configuration patching with automatic backup creation (`config.json.zn-backup-<timestamp>`).
  - Supports `--dry-run` for risk-free auditing, `--shadow` for non-blocking observation, and `--revert` for instant 1-command rollback.
- **Universal MCP Security Proxy (`zn-gate shield`)**:
  - Lightweight stdio proxy that wraps any external MCP executable (`uvx`, `npx`, `node`, `python`).
  - Intercepts JSON-RPC 2.0 messages bidirectionally: blocks malicious arguments pre-execution and sanitizes poisoned tool results post-execution.
- **MCP Tool Poisoning & Description Defense**:
  - Automatically intercepts `tools/list` responses from external servers.
  - Deep-scans tool descriptions and parameter schemas (`inputSchema.properties`) for adversarial instructions before LLM context ingestion.
  - Neutralizes poisoned descriptions while preserving legitimate tool availability.
- **Cryptographic Evidence Engine**:
  - Tamper-evident SHA-256 hash-chained audit ledger (`~/.zn/evidence.jsonl`) recording every verdict, tool name, payload hash, and decision latency.
  - **100% Cross-Language Interoperability**: Identical canonical JSON serialization guarantees byte-for-byte SHA-256 chain verification across Node.js and Python.
  - Built-in verification via `zn-gate evidence --verify` and `verify_evidence_ledger()`.
- **Compliance Audit Exporter (SOC 2 / ISO 27001 / EU AI Act Art. 12)**:
  - Export audit ledgers into JSONL and CSV formats with genesis-to-tip integrity verification via CLI (`zn-gate evidence --export [--format=jsonl|csv] [--output=file]`).
  - Interactive local dashboard (`zn-gate evidence --ui`) with real-time stats and HTTP download endpoints (`/api/export?format=jsonl|csv`).
  - Full Python parity via `zn_gate.export_evidence_ledger()`.

---

## [1.2.4] - 2026-09-06

### Added
- **Hybrid Inspection Mode**:
  - Direct prompt injections and sensitive secret leaks are evaluated in-process in **< 10 µs at $0 cost**.
  - Obvious attacks short-circuit immediately with `mode: 'hybrid-local-fastpath'`, eliminating 100% of network round-trips and API egress costs.
  - When `ZN_API_KEY` is provided, clean inputs and tool results seamlessly escalate to the **zn Cloud Gate (v30)** for deep multilingual neural classification.
- **Python SDK Client**:
  - Pure stdlib client module (`zn_gate.analyze()`, `zn_gate.analyze_cloud()`, `zn_gate.resolve_endpoint()`) with **zero external dependencies**.
- **Agent Framework Integrations**:
  - Full support and test matrices for **LangChain** (`ZnGuardCallbackHandler`), **CrewAI** (`@guarded_tool`), **LlamaIndex** (`ZnLlamaGuard`), and **Promptfoo** custom evaluation provider.
- **Continuous Integration (CI)**:
  - Multi-platform GitHub Actions workflow (`.github/workflows/ci.yml`) covering Node 18, 20, 22 and Python 3.9 through 3.13.

### Optimized
- **LRU-2048 Cache Architecture**:
  - Implemented version- and config-guarded LRU cache for `evaluate()` in both Node.js and Python.
  - Latency on cached hits drops to **< 18 µs p99** (Node p50: 4.9 µs, Python p50: 0.9 µs).
  - High-throughput un-cached execution exceeds **114,000 req/s** (Node) and **17,000 req/s** (Python).

### Fixed & Hardened (Security)
- **Adversarial Fuzzing Hardening**:
  - Hardened `pi:ignore_previous`, `pi:disregard`, and `pi:override` against 1,500 fuzzer mutations.
  - Achieved **97.93% overall block rate** on evasion vectors (100% on zero-width, markdown wrapping, casing/spacing, and semantic framing).
- **False Positive Elimination on Developer Tool Outputs**:
  - Refined `pi:override` to target explicit attack objects (`system|policy|safety|rules|instructions|guidelines|restrictions`).
  - Achieved **0.00% False Positive Rate** across 400 real-world benign tool outputs (SQL, JSON, HTTP payloads, and technical documentation).

---

## [1.2.3] - 2026-09-05
- Automatic DLP credential masking (`redactSecrets` / `redact_secrets`).
- Enhanced AST pre-normalization for Cyrillic homoglyphs and invisible unicode characters.
- Initial release of Python SDK (`zn-gate` on PyPI).

## [1.2.0] - 2026-08-26
- MCP Server interface for Claude Code, Cursor, and custom agent loops.
- Bidirectional inspection for prompt inputs and tool returns.

[Unreleased]: https://github.com/usezn/zn/compare/v1.6.0...next
[1.6.0]: https://github.com/usezn/zn/compare/v1.5.1...v1.6.0
[1.6.0-beta.1]: https://github.com/usezn/zn/compare/v1.5.1...v1.6.0-beta.1
[1.5.1]: https://github.com/usezn/zn/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/usezn/zn/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/usezn/zn/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/usezn/zn/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/usezn/zn/compare/v1.2.4...v1.3.0
[1.2.4]: https://github.com/usezn/zn/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/usezn/zn/releases/tag/v1.2.3
