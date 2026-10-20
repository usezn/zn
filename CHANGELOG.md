# Changelog

All notable changes to `zn-gate` (Node.js & Python SDKs) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [1.13.0] - 2026-10-19

zn-gate 1.13.0 adds `zn-gate connect`, which turns on the optional cloud check for `analyze_prompt` with an analysis-only API key kept in your system keychain, and `zn-gate disconnect`, which can also revoke that key on usezn.com. It also adds `zn-gate report`, a local summary of what zn-gate did in the last days, and the agent hooks now check what a typed skill or command expands into and the code that shells and wrappers run from a string. zn-gate still needs no account and sends nothing by default. This release also fixes how a damaged audit log is handled (it is reported instead of crashing, and never used to start a new chain) and how several programs writing to it at once keep its hash chain intact and tightens when the saved cloud key can be used. Update with `npm install -g zn-gate@1.13.0` and `pip install -U zn-gate`.

### Added
- `zn-gate connect` turns on the optional cloud check for `analyze_prompt` from your own terminal. It opens usezn.com, you paste an analysis-only API key at a hidden prompt, and the key is kept in your system keychain or the zn vault, never in a file. `connect` accepts only a key limited to analyzing text, because such a key cannot read your usage or manage keys, so a leaked copy can do little; a full-access key is refused. `zn-gate status` shows whether a key is connected and where it comes from, without showing it. Nothing changes until you run it: zn-gate still needs no account and sends nothing by default. See [docs/connect.md](docs/connect.md).
- `zn-gate disconnect` removes the saved key and can also revoke it on usezn.com, so it stops working everywhere. It asks first (the default is no). Only an explicit yes sends anything: one request with the key to https://api.usezn.com, over the same checked connection `connect` uses. Once you have answered, the local copy is removed even if the revoke request fails; if the saved key cannot be read, nothing is removed and `--no-revoke` removes only the local copy. A failed revoke tells you and links https://usezn.com/api-keys. In your own terminal, `--revoke` skips the question and `--no-revoke` never revokes. `disconnect` only runs in your own terminal: from a script or an AI agent it refuses and changes nothing, with or without those options. zn-gate still needs no account and sends nothing by default. See [docs/connect.md](docs/connect.md).
- A zn API key (`zn_` followed by 48 characters) is now recognised by the scrubber and hidden like other provider keys.
- `zn-gate report` shows what zn-gate did on this computer in the last 7 days (`--since 1d-90d` for another period, `--json` for scripts): blocked actions by agent, secrets hidden by type, new protected MCP servers, tool changes waiting for your approval and the busiest day. It reads only local files, writes nothing and sends nothing. It ends with one line about zn Team, which `--no-team-line` hides and which does not appear once the computer has joined a Team. See [docs/report.md](docs/report.md).

### Changed
- GitHub Action: a new name and description for the GitHub Marketplace listing, clearer descriptions of the `path`, `mode` and `format` inputs, a guide for the audit mode (`docs/github-action.md`) and a minimal audit example. No change in behaviour.
- `zn-gate check` now tells you when the Claude Code hooks installed by an older zn-gate lack the check for typed skills and commands, and suggests running `zn hooks install claude-code` again. It says nothing for the plugin, which already has it.
- The `connect` help now says it takes an analysis-only API key.
- Added a glossary and "If something fails" lists to the secrets, reach, audit and Python package guides.
- The install steps in the README and the npm package README are easier to follow, with a short "If something fails" list. The `check` and `connect` guides gained the same kind of list.
- `zn-gate init` no longer installs the Claude Code plugin when Node.js is older than 20.12, which the plugin needs: it sets up zn's hooks for Claude Code instead and says so in one line, and `zn-gate check` reports an installed plugin on such a Node.js with the way out.
- The docs say what `zn-gate status` shows: the detection engine and whether the optional cloud check is on. Sharing of usage statistics has its own status, `zn-gate stats share status`.
- More automated tests cover `zn team` (the commands, offline and revoked machines, expired policies) and the organization's custom secret formats. No change in behaviour.
- More tests for the MCP servers and `zn run` (malformed messages, unknown methods, missing parameters, vault errors). No change in behaviour.
- More tests for the Python package scan command, evidence ledger and local stats (binary files, other encodings, size limits, empty folders, damaged ledgers). No change in behaviour.
- More tests for the Python SDK guard decorator and cloud client (network errors, timeouts, empty and malformed responses). No change in behaviour.
- More automated tests cover `zn-gate reach` and `zn audit` (agent settings, SARIF output and the reach memory file). No change in behaviour.
- More tests cover the vault's encrypted store, keychain metadata, audit log and confirmation prompts. No change in behaviour.
- The command line output of the Node.js and Python packages has no color codes when NO_COLOR is set to any non-empty value, when TERM=dumb, or when the output is not a terminal. With NO_COLOR or TERM=dumb it also leaves out symbols and box-drawing lines. The status words (ALLOWED, BLOCKED, FAILED, PASSED, ALLOW, BLOCK, clean) keep the meaning. Exit codes and the JSON, SARIF and agent hook outputs do not change.

### Fixed
- GitHub Action: the `version` input now defaults to the version of the Action release itself (1.13.0 here). The 1.12.0 release of the Action defaulted to 1.10.0, so a workflow on `usezn/zn@v1.12.0` without `version` installed zn-gate 1.10.0. Set `version` in your workflow to choose exactly what runs.
- The audit log (`~/.zn/evidence.jsonl`) is now checked for damage before anything is added to it. A log with unreadable bytes or a cut-off last line is reported as corrupted, with the line number, by `evidence --verify` (non-zero exit), `evidence` and `evidence --export`, instead of failing with a Python error. A damaged log is never used to start a new chain: the event is not written, a warning is shown (the first time, then every 5 minutes), and your command or agent carries on as usual. To recover, move the damaged file aside (`mv ~/.zn/evidence.jsonl ~/.zn/evidence.damaged.jsonl`; on Windows `cmd` `move %USERPROFILE%\.zn\evidence.jsonl %USERPROFILE%\.zn\evidence.damaged.jsonl`, in PowerShell `Move-Item $env:USERPROFILE\.zn\evidence.jsonl $env:USERPROFILE\.zn\evidence.damaged.jsonl`): the next event starts a new chain and the old file stays for review. An empty or missing log still starts a fresh chain. The Node and Python versions now read the log the same way, so a log with a byte-order mark or non-breaking spaces is reported the same by both.
- The hook no longer refuses a command that writes a file from a here-document (`cat > file <<'EOF'`) when the body holds a `*` or another glob character, and it checks a 100 KB body in a few milliseconds instead of tens of milliseconds.
- A here-document body is only read as data in a plain simple data command (`cat`, `tee`, `dd`, ...) with no pipe, process substitution or open group (also one opened on an earlier line). A pipe or a process substitution after the first body keeps the check too, so a `case` close inside a group opened on an earlier line cannot hide one. Bodies a shell, an interpreter, `xargs` or `parallel` runs, a program with an option that runs code (`sort`, `split`), a command that redefines a function or `PATH`, and a file the same command writes and then runs (also by an absolute path, also behind `nohup`, `timeout` or `exec`), are still refused. Every read of `.env` or a credential file on the command line is refused as before. The check is linear with the existing time budget, so 10 000 here-document operators or 50 000 parentheses on one line stay within it.
- The guard that stops a command from loading zn-gate's own key code now also catches upper-case paths, Windows-style `vault\keychain` paths and paths with `./` segments, such as `zn-gate/./lib/client`.
- `zn-gate reach --remember` shows the date of the previous run only when it is a plain date; an edited or damaged memory file can no longer put other text or terminal codes into the report.
- The scrubber no longer reports a masked example as a secret: an Anthropic key or an `Authorization: Bearer` value made mostly of one repeated character (for example `sk-ant-api03-xxxx...`) is treated as a placeholder. `SCRUB_RULES_VERSION` is `2026-10-17.3`.
- `zn audit`: when it hides a secret value in escaped JSON (`{\"password\":\"...\",\"user\":\"...\"}`), it hides only that value and keeps the next fields, and a URL after a flag such as `-url:` is no longer taken for `-u user:password`. (Also in 1.12.0.)
- Internal safety default in the vault: the function that deletes the vault key no longer touches the shared keychain entry when it has no record of which keychain this vault uses, unless the caller names one. Nothing in `zn-gate` calls it today, so there is no change for users.
- A log that exists but cannot be written (no permission, full disk) no longer makes the hook or proxy fail: the event is skipped, a warning is shown (the first time, then every 5 minutes) and the decision is unaffected.
- The Node and Python versions can now share one audit log that holds non-ASCII text (for example accented letters or CJK). Before, a record written by one failed verification in the other. New records are written as plain UTF-8 text; logs written by earlier versions of either one still verify.
- The rule that protects zn's key no longer mistakes a module named `cloud-keys` or `acme-cloud-key-manager` for zn's own `cloud-key` module.

### Security
- Some provider token formats were not redacted by the library API, the MCP tool checks, the text sent to the cloud analysis and the local evidence preview. They are now redacted the same way as in the Python package. The agent hooks were not affected.
- `zn audit` hides the value after a credential flag in an array of arguments in more cases, in its text, JSON and SARIF reports: single-quoted TOML items (`args = ['--token', 'VALUE']`), arrays written one item per line, quotes escaped once or twice, and a comment (also a multi-line block comment or one longer than 1024 characters), several blank lines, a very long line, a wide run of spaces or a literal `\n` between the flag and its value.
- Claude Code: zn now also checks what a typed skill or command expands into. A new `UserPromptExpansion` hook blocks the expansion, with the reason and the next step, when it would show the model a secret value, a private key or the lines of a `.env` file. If the hook cannot run, the expansion is blocked. Run `zn-gate hooks install claude-code` again to add it; the plugin has it already. To turn off `!` shell commands in skills altogether, set `disableSkillShellExecution: true` in Claude Code.
- The hooks refuse commands that ask the system keychain for zn's own entries (`security find-generic-password`, `secret-tool lookup`, `cmdkey /list`, `Get-StoredCredential` with zn's service or target name), and also `security dump-keychain` and code that loads the key through zn's own modules or a keyring library, so the direct ways for an agent to read the key saved by `zn-gate connect` or the vault key are closed. A program running as you can still ask the keychain, as for any entry. The same tools stay free for other entries. A saved key is only ever sent to `https://api.usezn.com`: `--url` and `ZN_API_URL` are ignored for it.
- The optional cloud check now turns on only with your own opt-in. A key in `ZN_API_KEY` still does nothing without `ZN_CLOUD=1`, even if the record `zn-gate connect` leaves in `~/.zn/config.json` was written by hand: when that record is what turns the check on, zn-gate uses only the key `connect` saved, only to https://api.usezn.com, and the record must match the saved key (its last four characters). If the key cannot be read, prompts are checked locally and zn-gate says so once.
- The agent hooks: a command that reads the system keychain for zn's entries is checked in linear time (it took several seconds on a 100 KB command before), and `zn-gate connect` and `zn-gate disconnect` now count as commands only the user may run. `POLICY_RULES_VERSION` is `2026-10-18.31`.
- The saved cloud key is also held back while `NODE_OPTIONS` has `--tls-keylog`, `--inspect` (with its variants) or `--openssl-shared-config`, and the zn vault's request tool for agents (`secrets_http_request`) never fills in that key, so an agent cannot use it to revoke the key or spend its quota. The vault does not give the key to the hooks, the secrets broker or `zn run`; a program running as you can still read it, as with any vault or keychain secret, and can use it to analyze text on your quota or revoke it (the key cannot read usage or manage other keys). The hooks also refuse a command that loads zn-gate's own client modules (found by their `zn-gate/lib/client` path) to ask for the key, as a barrier only.
- The saved cloud key is not used while `NODE_DEBUG` is set (Node can print request headers, key included): `connect`, `disconnect` and the cloud check say so in one line and send nothing. `NODE_OPTIONS` options are also recognised when written with underscores (`--tls_keylog`, `--inspect_brk`, `--experimental_loader`), which Node accepts, in the checks of `connect` and `zn audit`. `AUDIT_RULES_VERSION` is `2026-10-17.1`.
- The agent hooks: a glob that can match a private key file (`cat certs/*.key`, `certs/*`) is checked against the files it matches on the disk, a key file read after `cd` is looked up in the folder the `cd` leads to (an unknown `cd` refuses it, like a `.env`), and reading a key file from the git repository or its history (`git show HEAD:certs/server.pem`, `git log -p -- server.key`) is refused. Certificates and `.pub` files stay readable from the disk.
- The agent hooks: git is recognised behind `sudo`, `env`, `command`, `nohup` and `xargs`, a `<rev>:<path>` word naming a `.env`, credential or key file is refused anywhere in a command that runs git (`echo HEAD:.env | xargs git show`), and git pathspec magic (`':(top).env'`, `':/.env'`) is read as the path.
- The agent hooks: code run from a string is also checked behind more wrappers (`chrt`, `taskset`, `strace`, `ltrace`, `runuser`, `chroot`, `unbuffer`, `nsenter`, `script -c`) and when a wrapper is not one zn knows, after shell options such as `bash -O extglob -c` and `--rcfile`, for `fish -C`, for PowerShell parameters given as any prefix or with `/` (`-en`, `/Command`), for `powershell "<code>"`, and for `iex` and `Invoke-Expression` (also when a string is piped into them), and `sg -c`.
- `zn-gate reach`: a server, file or path name that contains a line break or a tab can no longer start a line of its own in the text report; such characters become a space. Zero-width and other invisible characters are removed from every name before secret values are hidden and again after, and the file that `--remember` keeps is ignored when it is larger than 1 MiB.
- The agent hooks: the code a shell or wrapper runs from a string (`sh -c`, `bash -lc`, `sudo sh -c`, `su -c`, `flock -c`, `env -S`, `eval`, `watch`, `pwsh -Command`, `cmd /c`, `Start-Process git -ArgumentList`; the `-c` of tools such as `psql` or `grep` is not code and is left alone) is now checked as a command of its own, so every rule applies inside it, including reading a `.env`, credential or key file from git history. Nesting deeper than three levels is refused.
- Hardened the audit log (`~/.zn/evidence.jsonl`), whose hash chain is what lets you notice if a record was changed or removed. Several processes writing at once (two agents in one project, or the Node and Python versions together) could each add a record after the same previous one and split the chain, so `evidence --verify` reported a break that was not tampering and a real break could be hidden among them. Every write now takes a short lock first (an `evidence.jsonl.lock` file next to the log, shared by both versions), so the records stay in one line. If the lock stays busy for 2 seconds the write is skipped with a warning instead of risking a split, and a lock left behind by a crashed process is cleared after 10 seconds. A writer that was paused for a long time and lost its lock checks this before writing, so it cannot add a record based on out-of-date information.
- A `record_hash` that is not 64 lowercase hex characters is now treated as a damaged last record, like other damage, instead of being trusted as the start of the next link.
- The key-protection rule now also recognises the module names when they are written with escape sequences (JavaScript or shell, such as `\x2f`) or split by quotes.
- The agent hooks: a `.env` file reached through a Windows root, a network share or an extended-length path (`type %CD%\.env`, `more \\server\share\.env`, `gc \\?\C:\path\.env`) is refused, because zn cannot read a path like that to check whether the file holds values, and a `.env` name is now recognised after a backslash separator on every platform.
- More automated tests read a `.env` with the commands of cmd.exe and Windows PowerShell (`type`, `more`, `copy`, `findstr`, `Get-Content`, `gc`, `-Path`, `-LiteralPath`, `Select-String`) over relative, absolute, drive-relative, profile-variable and UNC paths: a `.env` with values is refused and an ordinary file is allowed in every form, on Linux and in the Windows checks job. No change beyond the refusal above.

## [1.12.0] - 2026-10-18

zn-gate 1.12.0 adds `zn-gate reach`, a read-only report of what the coding agents on this machine can reach (secret names, credential files, MCP servers and agent settings) with the command that fixes each finding, also as SARIF for code scanning. Releases are now built and signed in a separate workflow (SLSA Build Level 3), and release tags are signed by a workflow with gitsign. `zn audit` stops showing secret values it did not recognise in the commands it quotes, and the agent hooks refuse long shell patches quickly again. The agent hooks also refuse more of the ways a shell command can reach a `.env` file with values (see Security). Update with `npm install -g zn-gate@1.12.0` and `pip install -U zn-gate`.

**If you verify releases:** from 1.12.0 on, the signer workflow of the GitHub attestations and Sigstore signatures is `build-release.yml`, not `release.yml`; `docs/verify-release.md` has both and the tag check.

### Added
- `zn-gate reach [path]` shows, in one screen, what the coding agents on this machine can reach: which agents are found and whether zn protects them, the `.env` files of the folder with the names of their secrets, the credential files in your home folder (`~/.aws/credentials`, SSH keys, `~/.npmrc` and others: checked only for whether they exist, never opened), the names of environment variables that hold a secret, and what `zn audit` finds in the MCP servers and agent settings of the folder and of your user. Each finding has the command that fixes it. It is read only: no value is ever shown, nothing is sent, no hook is started, and nothing is written unless you ask for it with `--remember`. `--json` gives the same report as JSON.
- `zn-gate reach --sarif` writes the report as SARIF 2.1.0 for code scanning. Findings about a file of the checked folder are results: the `zn audit` findings keep their rules, and a `.env` with secrets an agent can read is `ZNR002`. What belongs to the machine (agents not protected, credential files, environment variables with secrets) and files in the home folder are notifications of the run. `--fail-on high|medium|low` exits 1 when a finding at or above that level is found; the default, `none`, keeps reach a report that exits 0. A usage error or a failure exits 2.
- `zn-gate reach --remember` keeps the counts of the run (high, medium, low and the date, nothing else) in `~/.zn/reach-last.json`, so the next run with `--remember` shows what they were last time. Without it, reach writes nothing.
- `zn-gate check` and `zn hooks install codex` say when Codex will not run zn's hooks: hooks turned off with `[features] hooks = false` in your organization's `requirements.toml` or `managed_config.toml` or in your own `config.toml`, or `allow_managed_hooks_only` in `requirements.toml` without zn among the managed hooks. Codex gives no sign of it. Claude Code's `disableAllHooks` and `allowManagedHooksOnly` were already reported.

### Changed
- The README and the npm package page show the getting-started path in four steps: `zn-gate reach`, `zn-gate init`, `zn-gate check` and `zn-gate env shadow`. `zn-gate reach` is documented in full in `docs/reach.md`: what it shows, its flags and exit codes, the memory file of `--remember`, SARIF upload to code scanning, and what it never sends.
- The two MCP servers (`zn mcp` and the `secrets` server) are now checked against Claude Code 2.1.302 and the newest MCP SDK client. They keep answering with MCP protocol version 2024-11-05, whatever version the client asks for, and the compatibility page says so.

### Fixed
- The agent hooks: a long patch sent as a shell command (`apply_patch` in Codex) is refused in a fraction of a second again. To name a secret file in the message, zn now checks only the first 32 files of the patch (and, in other refused commands, the next 32 words after a wildcard) instead of every one on disk, which took several seconds for a patch near the 100 KB limit and could reach the agent's time limit for the hook on a slow machine. The decision does not change. `POLICY_RULES_VERSION` is `2026-10-17.2`.
- The agent hooks on Windows: a PowerShell command that already runs through `zn-gate run -- ...` with a secret placeholder is left as it is. Before, `zn-gate` was taken for a PowerShell cmdlet because of its name and the command was refused (`zn run -- ...` worked).

### Security
- [GHSA-rccq-h3xc-j9qj](https://github.com/usezn/zn/security/advisories/GHSA-rccq-h3xc-j9qj): the agent hooks could let a protected file be read without being checked when the command reached it indirectly, or when the command was too long or slow to check. The bullets below are the fixes.
- `zn audit` hides a secret value given as the next item of a JSON array after a credential flag, as in the arguments of an MCP server: `"args": ["--api-key", "..."]`. Earlier versions could quote it in the evidence of a finding.
- `zn audit` no longer shows secret values in a format it does not know when they follow a credential flag (`--token`, `--api-key`, `--password`), an auth header (`Authorization: Bearer ...`, `x-api-key: ...`) or a name such as `API_TOKEN=`, in the command lines and hook commands it quotes. Earlier versions could quote such a value in a finding; rotate any that a finding showed. References such as `$TOKEN` or `${API_KEY}` are kept.
- Releases are built, attested and signed by a separate reusable workflow, `build-release.yml`, whose build and signing jobs the release workflow calls but cannot reach. That makes the build provenance of the npm and Python packages SLSA Build Level 3. To verify a release from 1.12.0 on, the signer workflow of the GitHub attestations and Sigstore signatures is `usezn/zn/.github/workflows/build-release.yml` (earlier releases: `release.yml`; npm provenance and PyPI attestations still name `release.yml`); see `docs/verify-release.md`. The agent plugin's checks pick the signer workflow from the release's own tag.
- Release tags are created and signed by a workflow, `tag-release.yml`, with gitsign (Sigstore keyless signing), so the signature names that workflow and no person's identity. It runs only from `main`, checks that the commit is the head of its release branch, that every version matches and that every check passed, and waits for approval before it signs. From 1.12.0 on, the release workflow refuses to publish a tag unless it carries a valid signature from `tag-release.yml`. How to check a tag: `docs/verify-release.md`.
- The agent hooks: a `.env` file with values is refused when a command reaches it after changing directory (`cd app && cat .env`, also when the current folder's `.env` is shadowed), through a path built while the command runs (`cat $DIR/.env`, `cat $(...)/.env`), or from code given to an interpreter or shell (`python -c "open('app/.env')"`, `bash -c "cat app/.env"`). Earlier versions only checked the path as typed, from the current folder. `POLICY_RULES_VERSION` is `2026-10-17.5`.
- The agent hooks: a `.env` file with values is refused when a shell command names it with bash `$'...'` quoting (`cat $'\x2eenv'`, also with a NUL that ends the string) or `$"..."`, through an input redirection with a descriptor number or in read-write mode (`cat 0<.env`, `cat <>.env`, `exec {fd}<.env`), or as the value of a `name=value` argument (`dd if=.env`). `POLICY_RULES_VERSION` is `2026-10-17.6`.
- The agent hooks: reading a `.env` or credential file from the git repository (`git show HEAD:.env`, `git cat-file -p :app/.env`) or its history (`git log -p -- .env`, `git checkout HEAD -- .env`, `git archive HEAD .env`) is refused, like reading it from disk, also when the file is no longer on disk. Clean-up steps still work: `git rm --cached .env`, `git restore --staged .env`, `git checkout -- .env`, `git status`, `git check-ignore .env` and `git log --oneline -- .env`. `POLICY_RULES_VERSION` is `2026-10-17.7`.
- The agent hooks: a shell command that names a `.env` file in a subfolder through a wildcard (`cat app*/.env`, `cat src/*/.env`, `cat {a,b}/.env`) is refused, like the plain path. Earlier versions let it run, because the file was looked for under the pattern itself and not found. `POLICY_RULES_VERSION` is `2026-10-17.3`.
- Rust gateway in `src/` (experimental, not distributed: not part of the npm or PyPI packages or the plugin): post-quantum policy signatures are ML-DSA-65 (FIPS 204), verified with the maintained RustCrypto `ml-dsa` crate, instead of Dilithium3 from the unmaintained PQClean bindings; three `cargo audit` exceptions are gone. A policy signed with a Dilithium3 key must be signed again with an ML-DSA-65 key. See `docs/rust-core.md`.
- The agent hooks: a private key kept outside `~/.ssh`, for example in a project, is refused like one in `~/.ssh`: `id_rsa`, `id_ed25519` and the other SSH key names, key stores (`.p12`, `.pfx`, `.jks`, `.ppk`), and `.pem`, `.key` or `.p8` files that hold a private key. Certificates and public keys stay readable. `POLICY_RULES_VERSION` is `2026-10-17.8`.
- The agent hooks look inside a `.env` or key file without blocking: a FIFO or other special file with such a name is refused without being read, and a name repeated in a long command is checked once.
- The agent hooks check a shell command within a time and disk budget, well below the agent's hook timeout: a command with too many paths to check in time is refused, instead of running unchecked once the agent stops waiting.
- The agent hooks check every command in a long chain. Earlier versions checked only the first 1000 simple commands (lines count too) and let the rest run unchecked.

## [1.11.0] - 2026-10-17

zn-gate 1.11.0 finds more kinds of secrets with `zn-gate scan`, the agent hooks and the Python package (Square and Discord bot tokens, and 24 provider token formats taken from gitleaks), makes `zn-gate check` and `zn-gate init` clearer the first time you run them, and on Windows starts the system PowerShell in a way an AI agent cannot redirect. Update with `npm install -g zn-gate@1.11.0` and `pip install -U zn-gate`.

**If a CI job fails when `zn-gate scan` finds secrets:** it can start failing on tokens of the new types committed to the repository (for example Square, Discord, Grafana or Notion tokens). Look at each finding and rotate any real token.

### Added
- `zn-gate scan`, the agent hooks and the Python package find 24 more provider token formats, taken from gitleaks (MIT; notice in `THIRD_PARTY_NOTICES.md`): 1Password service accounts, age secret keys, Alibaba Cloud, Artifactory, Cloudflare Origin CA, Dynatrace, EasyPost, Fly.io, Grafana, Terraform Cloud, Heroku (new format), Notion, Perplexity, PlanetScale, Postman, Prefect, Pulumi, ReadMe, RubyGems, Brevo (Sendinblue), Sentry user tokens, Shippo, OpenShift and Microsoft Teams webhooks. Only formats with a fixed provider prefix were taken, each with the same check that its body looks random; gitleaks' generic rules were not. `RULES_VERSION` is `2026-10-16.10`.
- `zn-gate scan`, the agent hooks and the Python package also find Square access tokens and OAuth secrets (`EAAA...`, `sq0atp-...`, `sq0csp-...`) and Discord bot tokens. A Discord token counts only when its first part encodes a numeric bot id, so dotted random strings are not reported.

### Changed
- GitHub Action: the default `version` is now 1.10.0, and the README and examples pin the action to the v1.10.0 commit.
- `zn-gate check` and `zn-gate init` are clearer the first time you run them: `check` lists an agent that is not on this machine as "not found on this machine" instead of offering a setup for it; when zn-gate was only run with `npx`, its setup for Codex CLI, Cursor and OpenCode starts with `npm install -g zn-gate` (`zn hooks install` needs it); when nothing is set up, or an agent is found but not set up, it points to `npx -y zn-gate init`. The help lists `zn hooks install` for every agent, and the "secrets" MCP server note after `zn hooks install` says that it is optional. What the commands do and their exit codes do not change.
- README, npm and Python package pages: `npx -y zn-gate init` is the one install path shown first; the other ways (one agent at a time, other editors, Python, MCP server only and, in the README, wrapping the MCP servers you already use) are folded under "Other ways to install". The npm, PyPI and MCP Registry descriptions use the same product sentence as the README and the website.

### Fixed
- The agent hooks: when a command is refused because of a secret file, the message names that file (`.env`) rather than a wildcard word such as `***`, and a patch sent as a shell command (`apply_patch` in Codex) is refused with the file it writes, or with the reason (zn cannot check a patch in that form file by file) and the next step. The decision itself does not change. `POLICY_RULES_VERSION` is `2026-10-16.8`.

### Security
- `zn-gate pins approve` also refuses to run under an AI agent, found by its environment variables or by its command-line program among the parent processes, like the other commands that only you may run.
- Rust gateway in `src/` (experimental, not distributed: not part of the npm or PyPI packages or the plugin): bans are kept per tenant namespace, an allowed call forwards the sanitized images, `/mcp/ws` limits messages to 1 MiB, and query-string credentials are accepted only for SSE and WebSocket. See `docs/rust-core.md`.
- On Windows, the approval dialog of the secret vault, the Windows Credential Manager backend and `zn secret set --clipboard` now start the system PowerShell (Windows PowerShell 5.1) found through the kernel's `\SystemRoot` link, as `zn run` already did for `cmd.exe`, instead of the path in the `SystemRoot` variable, which an AI agent running zn can change. Without the system PowerShell, the dialog is not shown (approvals are refused) and the Credential Manager backend stops with an error that suggests `zn unlock --backend passphrase`.

## [1.10.0] - 2026-10-16

zn-gate 1.10.0 adds an audit mode with SARIF output to the GitHub Action, makes the commands that only you may run harder for an AI agent to start, gives the right repair in `zn-gate check` and `zn-gate init` when the zn-gate plugin is broken next to zn's own hooks, and checks long shell commands much faster. Update with `npm install -g zn-gate@1.10.0` and `pip install -U zn-gate`.

**If you run `zn unlock` from a script with the system keychain:** it now needs an interactive terminal (`--passphrase-stdin` with the passphrase backend still works from a pipe). **If you scan docker-compose files or `.env.example`:** database URLs whose password is only a reference such as `${PGPASSWORD}` are no longer reported.

### Added
- GitHub Action: `mode` input (`scan`, `audit`, `both`; default `scan`). `audit` runs `zn audit` from the npm package on agent configs, hooks, MCP servers, plugins and skills; `both` runs the scan and the audit, and runs the scan only, with a warning, when `version` is older than 1.6.0 or is a PyPI-only `.post` version. `mode: scan` keeps the previous behaviour.
- GitHub Action: `format: sarif` writes a SARIF file with one run per check and exposes it as the `sarif-file` output, for `github/codeql-action/upload-sarif`. New inputs `severity-threshold` (`critical`, `high`, `medium` or `low`; default `high`: the lowest audit severity that fails the step when `fail-on-threat` is `true`), `fail-on` (passed to `zn audit --fail-on`; overrides `fail-on-threat` and `severity-threshold` for the audit), `agents`, `sarif-file` (inside the workspace or the runner temp directory, never through a symbolic link) and `npm-integrity`; new outputs `audit-exit-code` and `sarif-file`.

### Changed
- GitHub Action: the default `version` is now 1.9.0.
- GitHub Action: `fail-on-threat` must be `true` or `false`, in any case (`True` and `FALSE` still work); any other value now fails the step instead of being read as `true`.
- Contributors: a pull request describes its change in a `changelog.d/` fragment instead of editing `CHANGELOG.md`, and the release collects the fragments into its section. A new `Changelog` check asks for a fragment when a pull request changes what ships.

### Fixed
- The agent hooks check a long shell command faster: each word is looked up once per command, so a command of 80 KB that repeats its words takes well under a second instead of several seconds. A hook that runs out of time lets the command go ahead unchecked, so this also keeps long commands checked. `POLICY_RULES_VERSION` is `2026-10-16.6`.
- `zn-gate check` and `zn-gate init`: when both the zn-gate plugin and the hooks of `zn hooks install claude-code` are set up and the plugin does not work (for example on a Node.js the plugin does not support), they now check those hooks too, and run them the way Claude Code does. If the hooks work, the fix is to turn the plugin off with `claude plugin disable zn-gate@usezn`, which keeps them, instead of removing the hooks. If the hooks do not work either, the hooks are repaired first (`npm install -g zn-gate`, then `zn hooks install claude-code`) and only then is the plugin turned off, so the plugin is turned off only after the hooks are repaired. A Claude Code setting that stops all hooks (`disableAllHooks`, managed settings) is reported as such, and neither the plugin nor the hooks are touched.
- `zn-gate check` and `zn-gate init`: when zn's own rules do not block the test `.env` file, the fix is now to install zn-gate again (`npm install -g zn-gate`), also with the zn-gate plugin; before, they asked to install the plugin that was already installed.
- `zn-gate init`: with a broken plugin next to zn's own hooks that do not work either, it now checks that the repaired hooks work before it turns the plugin off, and leaves the plugin on when they still do not.
- A database URL whose password is only a reference to a name (`postgres://${PGUSER}:${PGPASSWORD}@db/app`, `$PASS`, `%PASS%`, `<password>`, `{{ password }}`; `${name}` may also be lower case) is no longer reported or redacted as a secret, in Node.js and Python alike. Anything else is still a password, including a lower-case `$word` or `%word%` and digits inside `<>` or `{{ }}`. `RULES_VERSION` is `2026-10-16.6`.

### Security
- Commands that only you may run (`zn secret set` and the other secret commands, `zn unlock`, the guided `zn-gate init`) now also check the parent processes for the AI agents' command-line programs (`claude`, `codex`, `opencode`, `cursor-agent`), which makes it harder for an agent that removed its environment variables to run them. It is not a guarantee: a process can detach from its parent, and the hook that denies these commands to agents stays the main guard. Editor apps such as VS Code or Cursor are not counted, so their integrated terminals keep working.
- `zn unlock` with the system keychain now needs an interactive terminal, since that unlock asks nothing. `--passphrase-stdin` still works from a pipe.

## [1.9.1] - 2026-10-16

zn-gate 1.9.1 finds more kinds of secrets with `zn-gate scan` and says what to do about each one, gives repairs that work in `zn-gate check` and `zn-gate init` (also after a Node.js version is removed), and closes ways an AI agent could start the guided `zn-gate init`. It also stops clearly on Node.js older than 18. Update with `npm install -g zn-gate@1.9.1` and `pip install -U zn-gate`.

**If a CI job runs `zn-gate scan`:** the Node.js scan now reports more secret types, so a job that fails on findings can start failing on files that passed before. **If you use the agent hooks:** a prompt that holds an opaque `Authorization: Bearer` token is now blocked, and one in a tool's output is replaced.

### Added
- `zn-gate scan` finds more secrets, in Node.js and Python alike: values of `--api-key=`, `--password=`, `--token=`, `--secret=` and similar flags on a command line; quoted values assigned to a name that ends in password, secret, token or api key with `=`, `:`, `:=` or `=>` (also `$password = "..."`), when the value looks machine-generated; an opaque `Authorization: Bearer` token; and the password in `https://user:password@host` and `ssh://user:password@host` URLs, such as git remotes. A flag without a value, a reference (`$TOKEN`, `${API_KEY}`), a placeholder (`<token>`, `changeme`) and a URL without a password are not reported. The Node.js scan now also reports the provider token formats the Python scan already reported (Slack, Stripe, Google, Hugging Face and the others the scrubber knows), with the same rule names.
- `zn-gate scan` reads UTF-16 files that start with a byte order mark, and the private key files `id_xmss` and `identity`.
- The scrubber also replaces an opaque `Authorization: Bearer` token (new type `BEARER_TOKEN`), as the Python package already did; zn's own `__ZN_<NAME>__` markers are left alone. GitHub's fixed `x-oauth-basic` password (`https://<token>:x-oauth-basic@host`) is no longer a URL password in either package; the token in the user part is still found by its own pattern. A password that is only a reference (`%NAME%`, `$NAME`, `${NAME}`, `<name>`, `{{name}}`) is not one either, while a literal password is redacted whatever the user part says. `RULES_VERSION` is now `2026-10-16.4` and `SCRUB_RULES_VERSION` `2026-10-16.3`.

### Changed
- With Node.js older than 18, the `zn-gate` and `zn` commands you run stop with a short message that names the version and how to install Node.js 18 or later (exit code 1). Hooks, MCP servers and the `zn run` commands that zn's hooks write keep running and print a warning, so a check that works today is not turned off. Node.js 16 and 17 were never supported; some commands happened to run on them.
- The Python `zn-gate` says that commands such as `hooks`, `init`, `check` and `unlock` are in the npm package and gives `npx -y zn-gate init`, instead of argparse's "invalid choice" error.
- `zn-gate check`: when a hook cannot start because its Node.js or its zn-gate files are gone (for example after `nvm uninstall`), the fix it gives is a fresh `npm install -g zn-gate` and then `zn hooks install <agent>`, since the old Node.js took its `zn` with it. Claude Code set up with `zn hooks install` is told to run that again rather than to install the plugin. The zn-gate plugin together with the hooks of `zn hooks install claude-code` is reported as not protected, because both run and a broken one can block every prompt; the fix is `zn hooks uninstall claude-code`. A zn-gate plugin that is turned off is fixed with `claude plugin enable zn-gate@usezn`; next to zn's own hooks, which then are the ones that protect Claude Code, it is only noted. `zn-gate init` follows the same routes. A Claude Code prompt hook without `onFailure: "block"` gets a note.
- The Python source distribution is now reproducible: two builds of the same commit with the same build tools give the same file, byte for byte, as the wheel and the npm tarball already did. CI and the release workflow build it twice and fail if the two differ.
- `zn-gate scan` says "Secret found" for a secret, instead of calling it a threat, and adds one next step in plain words: run `npx -y zn-gate env shadow <file>` to move the values of a `.env` file into the local vault (the file name is shown only when it is made of plain characters and does not start with `-`, otherwise the command says `<file>`), run `npx -y zn-gate secret set NAME` to store any other value, move a private key out of the file, and rotate anything that was ever committed or shared. The value is never printed. In `--format github`, a secret's annotation is titled `Secret found (<rule>)` and its message is the next step; the summary line reads `Found N secrets and M security threats.` In `--format json`, each secret has a new `next_step` field and the report has a new `total_secrets` count; `total_threats` still counts every finding and the other fields are unchanged. Injection findings keep their wording.
- The Node.js scan reports more secret types than before (the provider formats, Bearer tokens, URL passwords, command-line flags and assignments above), so a CI job that fails on findings (`fail-on-threat`, or the exit code of `zn-gate scan`) can start failing on files that passed before.
- Agent hooks (Node.js): a prompt that holds an opaque `Authorization: Bearer` token is now blocked, and one in the output of a tool or MCP call is replaced, as for the other secret formats the scrubber knows. Use `zn secret set NAME` and the `__ZN_NAME__` marker in its place.
- Docs: the Python install steps say that Debian and Ubuntu need the `python3-venv` package for `python3 -m venv`.
- Docs: what to do when your agent blocks every prompt because zn's hook cannot run (usually after Node.js is upgraded or moved): `zn-gate check`, reinstall, or turn zn off for that agent until it is fixed (docs/compat.md).
- Docs: the README, docs/secrets.md and docs/check.md describe the 1.9.1 behaviour: "Secret found" and its next step in `zn-gate scan`, the secret types it finds (and that a CI job can start failing on files that passed before), the Node.js 18 message, the repair steps of `zn-gate check`, the guided `zn-gate init` without arguments, and `zn hooks uninstall claude-code` keeping other `secrets` MCP servers.

### Fixed
- `zn hooks uninstall claude-code` removed any user MCP server called `secrets` from Claude Code, also one that was not zn's. It now removes only zn's own server, recognised by its exact command (zn-gate's `secrets-mcp`), and says so when it leaves another one in place. `zn hooks install` no longer overwrites another `secrets` server that only mentions `secrets-mcp`.
- An AI agent could start the guided `zn-gate init` despite the rule that keeps agents from running it: with a backslash or other characters the shell joins into one word, an option in capital letters, or `npm exec`, which keeps the options after the package for itself. These are refused now, and the guided `zn-gate init` stops with an error when it gets any argument. An agent variable such as `CLAUDECODE` that is set but empty now also counts as an agent. `POLICY_RULES_VERSION` is `2026-10-16.5`.

## [1.9.0] - 2026-10-16

zn-gate 1.9.0 makes `npx -y zn-gate init` the one command that sets up zn for the coding agents on your machine, and adds `zn-gate check` to show that zn stops your agent from reading a secret. Block messages for commands only you may run now give the exact command. Update with `npm install -g zn-gate@1.9.0`; the Python package has no code changes and moves to 1.9.0 to keep the versions in step.

**Breaking for scripts:** `zn-gate init` without options no longer wraps the MCP servers in your agent configs. Use `zn-gate init --wrap-mcp`.

### Added
- `zn-gate init` is now a guided setup: it finds Claude Code, Codex CLI, Cursor and OpenCode, shows the one route that protects each agent that is not protected yet (the zn-gate plugin for Claude Code, `zn hooks install` for the others, from a global install rather than the npx cache), runs each step after you confirm it in your own terminal, and ends with `zn-gate check`. When an AI agent or a script runs it, it only prints the steps.
- `zn-gate check` (also `zn-gate doctor`) shows that zn stops your coding agent from reading a secret. For each agent set up for your user (Claude Code through the zn-gate plugin or `zn hooks install`, Codex CLI, Cursor, OpenCode), it asks zn's hook to let the agent read a `.env` file with a fake key and an ordinary file, in a temporary folder. An agent counts as protected only when the first is blocked and the second allowed. For Claude Code, Codex CLI and Cursor it also runs the installed hook, which finds a hook that cannot start or that blocks every file (on Windows, hooks installed as `zn hook <agent>` are checked against zn's rules instead, and the output says so). It says how to fix an agent that is not protected. Nothing is sent over the network and no setting changes. See [docs/check.md](docs/check.md).
- `zn hooks install claude-code` and `zn-gate status` warn when Claude Code settings stop zn from running: an organization policy that turns off all hooks (`disableAllHooks`), runs only its own hooks (`allowManagedHooksOnly`), or does not allow the `secrets` MCP server (`managed-mcp.json`, `allowManagedMcpServersOnly`, `allowedMcpServers`, `deniedMcpServers`), or `disableAllHooks` in your own settings. Claude Code does not show these. Only the settings files are read, not policy sent through claude.ai, MDM or the Windows registry.

### Changed
- The READMEs start with `npx -y zn-gate init`; the steps for each agent are under "Manual install".
- Block messages, third batch: zn commands that only the user may run (`hooks install` and `uninstall`, `unlock`, `lock`, `stats share on`, `secret`, `env shadow`, `pins approve`, `init`) each say what the command does and the command for the user to run, with the agent, secret name or file name when the agent's command had one, instead of one message about secret values for all of them. Reading or changing `~/.zn` now says how a command can still use a secret, and a secret after a shell keyword says why it cannot be filled in.
- Breaking for scripts: `zn-gate init` without options no longer wraps the MCP servers in your agent configs: that is now `zn-gate init --wrap-mcp`. `--dry-run`, `--shadow` and `--revert` still select it. The guided `zn-gate init` runs only in your own terminal and asks before each step; zn's hooks also refuse the usual ways an AI agent would start it, as they refuse `zn hooks install` (the zn-gate plugin for Claude Code gets this rule once it is pinned to 1.9.0). `--wrap-mcp` is not affected.
- CI: draft pull requests skip the test, package, plugin, Rust, Windows and action jobs until they are marked ready for review, and pushes that change only documentation skip the test and plugin workflows (Markdown in the packages and plugins still runs them); the plugin checks also skip documentation-only pull requests. On release pull requests, which are opened before the plugin can be pinned, a plugin pin one step behind the release is a warning in `Public facts`; it still fails on `main` and `next`, so `main` stays red after a release merge until the plugin is pinned. The `Plugin repository` workflow ends with a warning instead of failing while the plugin repository's copy of its checks is out of date.
- CI: pushes to `next` leave out the macOS jobs of the leak bench and the scrubber and vault tests, and run the plugin checks on macOS with Node.js 22 only; Ubuntu and Windows still run every version. The full matrix still runs on `main`, on pull requests into `main` and release branches, with the `full-ci` label and on manual runs. A new push to `next` cancels the CI runs still going for the previous one; runs on `main` always complete.
- CI: the Rust build cache is saved only from `main`; `next` and pull requests restore it and save nothing, so the repository stays under its 10 GB Actions cache limit. A new weekly `Cache cleanup` workflow deletes the caches of closed pull requests and can be run by hand as a dry run.
- The hash-pinned tool lists used by the CI and release workflows (`.github/ci-test-requirements.txt`, `.github/release-requirements.txt`) now say how to regenerate them with uv when a security alert names them, since Dependabot cannot update them.

## [1.8.2] - 2026-10-15

zn-gate 1.8.2 adds MCP tool annotations. Nothing else changes; the Python package moves to 1.8.2 to keep the versions in step. Update with `npm install -g zn-gate@1.8.2`.

### Added
- MCP tool annotations: every tool of the zn-gate and secrets MCP servers now has a title and says whether it is read-only, destructive, idempotent and reaches the outside world (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), so MCP clients can show it and ask before the tools that change things. analyze_prompt reaches the outside world only with the optional cloud check on. No change in what the tools do.

## [1.8.1] - 2026-10-15

**If you use the zn-gate agent hooks with Claude Code, Codex CLI, Cursor or OpenCode, update.** This release reads Codex and OpenCode patches the way those agents read them, and makes the secret scrubber and several other checks run in linear time. Update with `npm install -g zn-gate@1.8.1`; the Python package has no code changes and moves to 1.8.1 to keep the versions in step.

### Fixed
- The vault audit log no longer slows down when the end of the file holds a long run of blank lines before a large record. Reading the last record used a regular expression that took seconds in that case, on every new audit record.
- File names in a Codex or OpenCode patch (`apply_patch`), values in `.env`, `.npmrc` and `.znrules` files, and a few `zn audit` checks are now read in linear time. Long runs of blank lines, spaces, `*` or `=` used to make them take seconds. `SCRUB_RULES_VERSION` is now `2026-10-15.2` and `AUDIT_RULES_VERSION` `2026-10-15.1`.
- File names in a Codex or OpenCode patch (`apply_patch`) are read the way each agent reads them: lines split only at line feeds, and names in every form Codex or OpenCode could use. A patch with a name zn cannot read safely, or with a line that looks like a file marker but is not one, is blocked.

### Changed
- In Codex and OpenCode, a patch (`apply_patch`) longer than 100 KB is blocked, like shell commands over 100 KB, because zn could not check it within the time the agent waits for the hook.

## [1.8.0] - 2026-10-15

zn-gate 1.8.0 adds Warn rules for zn Team: an organization can have a secret use go ahead with a notice and an audit record instead of blocking it. Organization policy now also applies to `secrets_render_file` and to marker restores in the agent hooks. `zn-gate shield` pins the tools of the MCP servers it wraps, and block messages are written in plain words.

**After updating, run `zn unlock` once.** A vault that is still running from an older version keeps secrets as markers and tokens in the agent hooks until it is restarted; `zn unlock` restarts it.

**Going back to 1.7.1 in a zn Team organization with Warn rules:** an organization policy with `warn` rules stored by 1.8.0 is refused by 1.7.1, which then applies only your local settings until the next policy sync downloads a copy it can read. Stay on 1.8.0 or later in such an organization.

### Added
- Codex plugin layout: `plugins/tools/check-plugins.js` now checks the root manifest's `extensions.com.openai.hooks` path and the repository marketplace entry against OpenAI's Codex plugin documentation.
- MCP tool pinning: `zn-gate shield` records a hash of each tool of a wrapped server (the whole tool definition) from the first tool list it sees for that server (all its pages), and compares every later list with it. By default a tool that is new or changed since gets a notice at the start of its description that tells the model to ask you first, and the shield writes a warning; tools with a duplicated or invalid name are refused. With `"mcpPinning": "block"` in `~/.zn/config.json` (or `ZN_MCP_PINNING=block`) such tools are removed and calls to any tool that is not approved are refused. Only your own `~/.zn/config.json` can make the mode weaker than `warn`; the environment of an MCP server can only make it stricter. `zn-gate pins` lists the servers and what changed; `zn-gate pins approve <server>` accepts the changes, only in an interactive terminal, and the agent hooks refuse it from an agent. Pins are kept in `~/.zn/mcp-pins/` (the program, its arguments with secrets redacted, tool names and hashes). Limits: pinning covers tool definitions, not the server's code; the first list of a server is trusted, and so is the first list after its command line changes (for example a new package version); approving accepts the tools as they are listed then (the pins hold names and hashes, not the tool text); an agent that can run code on your machine can edit the pins or start a server without the shield, and the hooks only stop the commands they recognise (`POLICY_RULES_VERSION` is now `2026-10-15.13`).
- CI: a `Public facts` check fails a pull request when the release version, the agents with hooks, the license or the install command differ between the package and plugin manifests, the MCP Registry files and the pinned versions in the documentation (`.github/public-facts.json`).
- zn Team: a policy rule can warn instead of block (`"warn": true`). The use goes ahead, an audit record with the decision `warn` is written and uploaded to your organization, and you and the agent see `zn: your team policy would block <NAME> here (policy note: "<reason>"). It was allowed and recorded for your organization.` It applies wherever a block applies (`zn run`, `secrets_http_request`, `secrets_render_file`); a rule with both `deny` and `warn` makes the policy invalid. zn-gate now sends `X-ZN-Policy-Features: warn` when it downloads the policy, so the server sends `warn` rules only to versions that understand them. The OpenTelemetry export maps `warn` to severity `WARN`.

### Changed
- Block messages in plain words. When zn cannot read a credential file for the agent, the message names the file, says why and how to use the value instead (`zn secret set NAME`, then `__ZN_NAME__` in the command). A secret used in the wrong place of a shell command gets one short explanation and an example. When a command is not allowed to use a secret, `zn run` says so and gives the command to allow it. When the hook itself fails, the agent reads that the action was blocked and, if it happens again, to ask you to run `zn hooks install`, followed by the error detail. The text that replaces a tool output with instructions aimed at the agent now tells the agent not to act on it and to tell you.
- Block messages in plain words, second batch. PowerShell refusals, MCP and Monitor notices, and the notes on commands with secret placeholders now say what happened and give one next step. Errors a person reads gain a specific next step where they are raised, written for a person first and for an agent second; the "Not allowed" and "Not found" prefixes are unchanged. The Python guard returns one message with the reason and a next step: a blocked input says not to retry with reworded text, and a blocked tool result says not to use that result. The Python block text no longer shows the confidence value; read the rule and reason from the exception's `assessment` attribute. The default CrewAI fallback text changed: pass `fallback=` to keep a fixed string. (`POLICY_RULES_VERSION` is now `2026-10-15.14`.)
- Python 3.8 and 3.9 are no longer supported (both are past their end of life); pip on those versions keeps installing zn-gate 1.7.1.
- When an MCP call is too large for zn to check (arguments over 1 MB), the message now tells the agent to tell you and not to resend the content in parts.

### Fixed
- zn Team: `secrets_render_file` now applies an organization `deny`. Before, a `file` mode secret blocked by the organization policy could still be written to a file through this tool.
- Plugin repository checks: the Verify workflow no longer stops without a message on a release pull request (the comparison of the two trees ended the step under `pipefail`).

### Security
- A value the scrubber replaced with a token is not put back when it is also a stored secret that the organization's policy blocks. When the vault process was started by an older zn-gate, the hooks keep tokens as they are instead of restoring them and say so to you and the agent; `zn unlock` now restarts such a vault, and `zn vault status` shows the running vault's zn-gate version and flags an outdated one.
- Marker restores in the agent hooks now apply the organization's policy. When an agent writes a `__ZN_NAME__` marker into a git-ignored file, a secret the zn Team policy blocks stays a marker and the hook says why; a secret under a `warn` rule is restored, recorded with the decision `warn`, and the hook's message shows the warning.
- When an event cannot be read or part of zn-gate is missing, the message the agent reads no longer says how to let actions pass unchecked (`hooks.whenUnavailable`). That setting is still documented and is shown only to you (as the hook's message to the user in Claude Code).
- When an agent event is not valid JSON, the refusal no longer quotes the part of it that Node's parser shows, which could be tool output.
- The agent hooks again refuse zn admin commands written with a Windows path or `.cmd` (for example `C:\Users\me\AppData\Roaming\npm\zn.cmd secret reveal NAME` or `.\zn.cmd hooks uninstall`).
- Shell, PowerShell and Monitor commands over 100 KB are blocked instead of checked. Checking a command that long could take longer than the agent waits for the hook, and a hook that times out lets the command run unchecked. The message tells the agent to tell you and not to resend the command in parts (`POLICY_RULES_VERSION` is now `2026-10-15.15`).
- zn Team: a `warn` rule now also applies when the agent hooks put back a value the scrubber replaced with a token and that value is a stored secret under the rule: you and the agent see the notice, and the audit record has the decision `warn`.

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

[Unreleased]: https://github.com/usezn/zn/compare/v1.13.0...next
[1.13.0]: https://github.com/usezn/zn/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/usezn/zn/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/usezn/zn/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/usezn/zn/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/usezn/zn/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/usezn/zn/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/usezn/zn/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/usezn/zn/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/usezn/zn/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/usezn/zn/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/usezn/zn/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/usezn/zn/compare/v1.5.1...v1.6.0
[1.6.0-beta.1]: https://github.com/usezn/zn/compare/v1.5.1...v1.6.0-beta.1
[1.5.1]: https://github.com/usezn/zn/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/usezn/zn/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/usezn/zn/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/usezn/zn/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/usezn/zn/compare/v1.2.4...v1.3.0
[1.2.4]: https://github.com/usezn/zn/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/usezn/zn/releases/tag/v1.2.3
