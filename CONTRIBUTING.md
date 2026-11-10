# Contributing to zn

Thank you for your interest in contributing to **zn**! We welcome bug reports, rule improvements, security research, and pull requests.

How the project is maintained, how pull requests are reviewed and how releases are made: [GOVERNANCE.md](GOVERNANCE.md). Pull requests target the `next` branch. Releases ship weekly: a pull request merged into `next` by Thursday goes into that week's release candidate and, after testing, into the release on Tuesday ([release schedule](GOVERNANCE.md#release-schedule)).

## Where to start

New to the project? These eight tasks are small and self-contained. Each one names the files to read, the one command that runs its tests, and what a good pull request contains. Open your pull request against the `next` branch. Reviewers check that user-visible changes add a changelog fragment (see [changelog.d/README.md](changelog.d/README.md)).

Install the Node.js dependencies once with `cd packages/zn-gate` and `npm ci --ignore-scripts`. Run each command from the repository root unless a `cd` says otherwise.

1. **Add a detection rule with a benign counter-test.** Files: `packages/zn-gate/lib/rules.js`, its Python twin `packages/zn-gate-py/src/zn_gate/rules.py`, and a rule test file such as `packages/zn-gate/test/rules_ignore.test.js`. Test: `cd packages/zn-gate` and `node --test test/rules_ignore.test.js`. Good PR: a rule ID that follows [Adding New Rules](#adding-new-rules), an ordinary sentence that must stay allowed next to the attack that must be blocked, and the version bump and snapshot update described in [Changing a rule](#changing-a-rule).

2. **Add an editor or agent setup page.** Files: a new `docs/editors/<name>.md` (copy the layout of `docs/editors/zed.md`) and a row in the table in `docs/editors/README.md`. Test: `.github/markdownlint/node_modules/.bin/markdownlint-cli2` (install it once with `npm ci --prefix .github/markdownlint --ignore-scripts`). Good PR: setup steps a beginner can follow, and a "Tested by us" entry that says exactly what you ran. Write "Not yet verified" if you did not run it.

3. **Add an example for another agent framework.** Files: a new `examples/<framework>-agent/` folder with `agent_guard.py`, a `requirements.txt` that pins one `zn-gate==` release, and a `README.md`. Start from `examples/haystack-agent/`. Test: `python3 .github/scripts/examples-smoke.py run --only <framework>-agent`. Good PR: the example's README shows the output it really prints, and the smoke run passes.

4. **Fix a docs page.** Files: any page under `docs/` (for example `docs/first-5-minutes.md`) or a package README. Test: `.github/markdownlint/node_modules/.bin/markdownlint-cli2`. Good PR: one fix per change, with a short note on what was wrong. Any command you change has been run by you.

5. **Add a Windows check.** Files: `packages/zn-gate/test/hook_dir_windows.test.js`, whose Windows-only cases are skipped on other systems. Test, in Windows PowerShell: `cd packages/zn-gate` and `node --test test/hook_dir_windows.test.js`. On other systems the same command passes and the Windows cases are skipped. Good PR: a case that fails before your fix and passes after it on Windows, with the output of that run in the pull request.

6. **Add a line to the benign corpus.** Files: `packages/zn-gate/test/fixtures/benign_phrases.json`, the `phrases` list. Test: `node bench/rules_fp_gate.js`. Good PR: one ordinary sentence that a developer really writes, with no real secrets or real hosts. If the block count rises, the baseline change in `bench/rules_fp_baseline.json` is explained in the pull request, as described in [Changing a rule](#changing-a-rule).

7. **Add a Python parity test.** Files: `packages/zn-gate-py/tests/test_cli_parity.py`, which checks that the Python CLI behaves like the npm package. Test: `cd packages/zn-gate-py` and `python -m pytest tests/test_cli_parity.py -v`. Good PR: one new case next to the existing ones, with the same text and exit code as the Node CLI.

8. **Check an agent's version handling.** Files: `packages/zn-gate/lib/agents/claude-code.js` (it has version-dependent behavior, for example for Claude Code 2.1.295 and later) and `packages/zn-gate/test/hooks_claude_launcher.test.js`. Test: `cd packages/zn-gate` and `node --test test/hooks_claude_launcher.test.js`. Good PR: the agent version you checked and where you found it, and a test that pins the behavior for that version.

## Architecture Overview

`zn` is designed as a local-first security gate with minimal dependencies:
- `packages/zn-gate/`: Node.js SDK, CLI, MCP Server, and stdio Shield proxy. Its only runtime dependency is `age-encryption` (with its `@noble`/`@scure` dependencies) for the secret vault, bundled in the package.
- `packages/zn-gate-py/`: Python SDK, CLI, and agent framework integrations (Python standard library only).
- `src/`: legacy Rust gateway (see [docs/rust-core.md](docs/rust-core.md)); not released as a package. CI builds, tests and lints it ([rust.yml](.github/workflows/rust.yml)).

## Development Setup

### Prerequisites
- Node.js >= 18.0.0
- Python >= 3.10
- (Optional, legacy Rust gateway) Rust stable, `protoc` 29 or later

### Running Tests Locally

#### Node.js (`packages/zn-gate`)
```bash
cd packages/zn-gate
npm test
```
This runs the full unit test suite, shield proxy tests, auto-shielding init tests, cryptographic evidence tests, and the 51-vector self-test suite.

#### Python (`packages/zn-gate-py`)
```bash
cd packages/zn-gate-py
python -m pip install -e .
python -m pytest tests/ -v
```

## Run the required checks locally

A pull request into `next` must pass these checks. Run the matching commands before you push. All commands start from the repository root unless a `cd` says otherwise. The check names are the ones you see on the pull request.

Windows notes: use PowerShell, and run each command on its own line (Windows PowerShell 5.1 has no `&&`). Where the workflow calls `python3`, use `python` (or `py`). On Windows, `npm` tools that CI starts from `node_modules/.bin` have a `.cmd` shim. Commands marked "bash" need Git Bash or WSL on Windows.

| Check | Commands | Linux and macOS | Windows (PowerShell) |
| --- | --- | --- | --- |
| Node.js 18, 22 and 24 tests and benchmarks | `cd packages/zn-gate`, `npm ci --ignore-scripts`, `npm test`, `node test/integration/test_agent_workflows.js`; then, from the root, `node bench/bench_node.js` | Same | Same. Only your installed Node.js version runs; CI runs 18, 22 and 24. |
| Python 3.12 tests and benchmarks | `python -m pip install --require-hashes -r .github/ci-test-requirements.txt`, `python -m pip install --no-deps --no-build-isolation -e packages/zn-gate-py`, `cd packages/zn-gate-py`, `python -m pytest tests/ -v`; then, from the root, `python bench/bench_python.py` | Same | Same |
| Lint (eslint, ruff, mypy) | See the Lint commands below | Same | Same, with `eslint.cmd` |
| Public facts | `node .github/scripts/check-public-facts.mjs`, `cd packages/zn-gate`, `npm run check:rules`; for a pull request also `git fetch origin next` and `node .github/scripts/check-rule-versions.mjs origin/next` | Same | Same |
| leak bench | `bash packages/zn-gate/test/fixtures/benign/fetch_corpus.sh`, `node packages/zn-gate/test/fixtures/benign/build_manifest.js --verify`, `node bench/rules_fp_gate.js`, `node packages/zn-gate/test/fixtures/fake_secrets.js --selftest`, `node bench/leak_bench.js --require-engine --json leak_bench_results.json` | Same | The corpus download is a bash script (needs `bash`, `curl`, `tar`): run it in Git Bash, or let CI run this check. The `node` commands run in PowerShell. |
| Windows (Node.js 22) | `cd packages/zn-gate`, `npm ci --ignore-scripts`, `npm test`, `node test/vault.test.js`; then, from the root, `node plugins/tools/test-launch.js` | Same | Same, with Node.js 22 installed. This is the check that runs the suite on Windows; the native keychain step of `node test/vault.test.js` needs `ZN_TEST_NATIVE_KEYCHAIN=1` and runs only in CI. |
| scrubber + vault | `cd packages/zn-gate`, `npm ci --ignore-scripts`, then `node test/contract.test.js`, `node test/scrub_patterns.test.js`, `node test/scrub_structured.test.js`, `node test/scrub_exact.test.js`, `node test/scrub_engine.test.js`, `node test/vault.test.js` | Same | Same. The CLI smoke step and the native keychain steps run only in CI. |
| Python package (build, twine check, install) | `python -m build --no-isolation packages/zn-gate-py --outdir dist-check`, `python -m twine check --strict dist-check/*`, `python -I .github/scripts/check-python-pack.py dist-check/*.whl dist-check/*.tar.gz` | Needs `build` and `twine` installed | Runs in CI. The workflow also rebuilds twice and compares checksums with bash tools. |
| npm package (pack, inspect, install) | `cd packages/zn-gate`, `npm ci --ignore-scripts`, `npm pack --json --pack-destination <dir> > <dir>/pack.json`, then from the root `node .github/scripts/check-npm-pack.js <dir>/pack.json packages/zn-gate` | Same | Runs in CI. The workflow checks the tarball with bash. |
| build, test, clippy, fmt (Rust) | `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo build --locked`, `cargo test --locked` | Needs Rust stable and `protoc` 29 or later | Same commands, if you install Rust and `protoc`. CI runs them on Ubuntu. |

CI skips the Node.js, Python, leak bench, scrubber and package checks (they report success) when a pull request changes only documentation or only the Rust gateway.

### Lint commands

```bash
cd .github/eslint
npm ci --ignore-scripts
cd ../../packages/zn-gate
../../.github/eslint/node_modules/.bin/eslint -c ../../.github/eslint/eslint.config.mjs --max-warnings 0 .
cd ../zn-gate-py
python -m pip install --require-hashes -r ../../.github/ci-test-requirements.txt
python -m ruff check .
python -m mypy
python -m mypy --strict src/zn_gate/__init__.py src/zn_gate/rules.py src/zn_gate/guard.py src/zn_gate/client.py src/zn_gate/evidence.py typing_check/check_public_api.py
```

On Windows, run these in PowerShell on separate lines and call `..\..\.github\eslint\node_modules\.bin\eslint.cmd` with the same arguments. CI installs ruff and mypy from `.github/ci-test-requirements.txt` with pinned hashes; use that file with `--require-hashes` if you want the same versions.

### Doc snippets

If you edit a marked snippet, list and run them with `python .github/scripts/doc-snippets.py list` and `python .github/scripts/doc-snippets.py run`. The network-isolated mode (`--netns`) works only on Linux with `sudo`; elsewhere, CI runs it.

### Documentation checks

If your pull request changes a page under `docs/`, a README or `changelog.d/README.md`, run these three checks first. They are the same ones CI runs on documentation.

1. Docs tests (Node.js only, no install needed):

   ```bash
   cd packages/zn-gate
   node --test test/docs_*.test.js test/docs-env-vars.test.js test/install_docs_match.test.js
   ```

   They check anchors, relative links, headings, command names and subcommands, environment variables and that the install instructions agree across pages. `npm test` runs them too, together with the rest of the suite.

2. Markdown lint, with the settings in `.markdownlint.jsonc` and `.markdownlint-cli2.jsonc`. From the repository root, install the pinned tool once, then run it:

   ```bash
   npm ci --prefix .github/markdownlint --ignore-scripts
   .github/markdownlint/node_modules/.bin/markdownlint-cli2
   ```

3. Link check with [lychee](https://github.com/lycheeverse/lychee) (the workflow pins `lychee-v0.24.2`; install it yourself). The offline run checks relative links and anchors, and fails when one is broken:

   ```bash
   lychee --config .github/lychee.toml --offline --include-fragments --no-progress README.md docs "packages/*/README.md" plugins
   ```

   CI also checks external links, but only reports them and never fails the pull request.

## Your first pull request and draft pull requests

- The first pull request from a fork waits for a maintainer to approve the workflow runs. The repository requires this approval for every outside contributor, so the checks show as waiting until a maintainer selects "Approve and run". Nothing is wrong with your change.
- A draft pull request does not run the required checks, except Public facts. They stay pending until you mark the pull request as ready for review; then they start.

## Branch and pull request names

### Branch names

Use `<type>/<topic>`, where the topic is a short English description in lowercase words joined by hyphens:

- `fix/init-guard-after-node-removal`
- `docs/shield-exit-codes`
- `ci/changelog-empty-fragment`
- `test/windows-hook-paths`

Pick the type from what users get:

- `feat` for a new capability, `fix` for a behavior that was wrong, `perf` for speed, `docs` for documentation only, `test` for tests only, `ci` for workflows and checks, and `chore` for maintenance.

Do not put a person's name, a nickname, a company or customer name, an internal project name, or a ticket number in a branch name. Describe the change instead. Branches with the `release/` prefix and the `chore/backmerge-` and `chore/pin-plugin-` prefixes are used by maintainers for release work, so do not use them for other changes.

The branch name also names your changelog fragment: a change users will notice needs `changelog.d/<branch-name>.md` (see [changelog.d/README.md](changelog.d/README.md)).

### Pull request titles

Write the title in English, in the imperative mood, as a short statement of what changes for the user:

- `Accept the .cmd shim form in hook test expectations`
- `Add a common mistakes list to the uninstall page`
- `Warn when a changelog fragment is empty`

Say what the user gets or sees, not how you got there. Avoid titles such as "Refactor the parser", "Fix stuff" or "WIP". Keep the title short enough to read in a list, about 72 characters.

A `type:` prefix such as `docs:`, `ci:`, `test:` or `fix:` is optional. Both forms appear in the history, so either is accepted.

Do not put ticket numbers, names of people or names of internal tools in the title. Put the details in the description: what the change does, why, and the issue it closes, if any.

If the change fixes a security vulnerability, do not describe the exploit in the branch name, the title or the description. Report it privately first, as explained in [Security Vulnerability Reporting](#security-vulnerability-reporting).

## Adding New Rules

When adding new detection rules:
1. Ensure the rule ID follows naming conventions (`pi:name`, `evasion:name`, `exfil:name`, `indirect:name`).
2. Add the rule to **both** `packages/zn-gate/lib/rules.js` and `packages/zn-gate-py/src/zn_gate/rules.py`.
3. Bump `RULES_VERSION` in both packages.
4. Add positive test cases (attack vectors that must be blocked) and negative test cases (benign developer code that must be allowed).
5. Verify zero false positives against real technical text (SQL, React, Docker, shell scripts).

## Rule Versions and the Snapshot

Each rule layer has a version constant. A change to any file of a layer must come with a bump of that layer's constant, or the checks fail. The table shows which constant goes with which file.

| Layer | Constant | Files that need a bump | Python twin (same value) |
| --- | --- | --- | --- |
| Detection rules | `RULES_VERSION` | `lib/rules.js`, `lib/mcp-secrets.js` | `packages/zn-gate-py/src/zn_gate/rules.py` |
| Scrubber types | `SCRUB_RULES_VERSION` | `lib/scrub/patterns.js`, `lib/scrub/exact.js` | none |
| `zn audit` | `AUDIT_RULES_VERSION` | `lib/audit/rules.js`, `lib/audit/patterns.js` | none |
| Hook policy | `POLICY_RULES_VERSION` | `lib/hooks/policy.js`, `lib/broker/files.js`, `lib/broker/markers.js`, `lib/broker/dotenv.js`, `lib/shell-quote.js`, `lib/destructive.js` | none |
| Destructive commands | `COMMAND_RULES_VERSION` | `lib/destructive.js` | `packages/zn-gate-py/src/zn_gate/destructive.py` |

`lib/destructive.js` is in two rows, so a change there bumps both `POLICY_RULES_VERSION` and `COMMAND_RULES_VERSION`.

### Changing a rule

1. Make the change and bump the constant of every layer you touched. The version format is `YYYY-MM-DD.N`: a date and an integer, for example `2026-10-31.1`. The new value must be greater than the value on `origin/next`. Dates compare as text and `N` compares as a number, so `2026-10-14.10` is newer than `2026-10-14.9`.
2. Set the same value in the Python twin: `rules.py` for `RULES_VERSION`, `destructive.py` for `COMMAND_RULES_VERSION`. The Node and Python values must match.
3. From the repository root, run `node packages/zn-gate/scripts/update-rules-snapshot.js`. It rewrites `packages/zn-gate/test/fixtures/rules_snapshot.json` and refuses to record a change whose version did not increase.
4. From `packages/zn-gate`, run `npm run check:rules`. It runs only the snapshot test, in well under a second, so a missing bump or a stale snapshot shows up before the full test matrix. Run `npm test` before you push.
5. Commit the updated snapshot with the change.

The Python `rules.py` and `mcp_secrets.py` are not in the snapshot. The parity test (`test/rules_parity.test.js`) keeps `rules.py` equal to `rules.js`; `mcp_secrets.py` is kept equal to `lib/mcp-secrets.js` by the shared samples in `test/fixtures/mcp_config_secret_samples.json`, which both test suites run.

`npm test` runs `test/rules_snapshot.test.js`. It fails on a changed file with the same or an older version, on a version that moved without a file change, and on rule ids that were added or removed.

On pull requests, CI also runs `node .github/scripts/check-rule-versions.mjs origin/<base>`. It compares every version constant with the one at the merge base and fails when a version is lower, when a layer's files changed with the same version, or when the Node and Python packages disagree on `RULES_VERSION` or `COMMAND_RULES_VERSION`.

`--force` writes the snapshot anyway and prints a loud warning. Reviewers must justify, in the pull request, any hash change made without a version increase; do not approve one without that justification.

CI also runs the false-positive gate, `node bench/rules_fp_gate.js`. It counts the blocks over the benign corpus and over `packages/zn-gate/test/fixtures/benign_phrases.json`, and fails when the total, or the count for any rule, rises above `bench/rules_fp_baseline.json`. Lower counts pass with a warning that the baseline is stale. If your change must block more benign text, explain why in the pull request, then run `node bench/rules_fp_gate.js --update-baseline`. Changing the phrase list also changes the scanned count, so update the baseline in the same commit. Known false positives stay in the phrase list and in the baseline. The gate evaluates from an empty directory, so a local `.znrules` or `zn.config.json` cannot change its counts.

## Runnable doc snippets

A code block in `README.md`, `packages/*/README.md` or `docs/*.md` is tested when the line above its opening fence is this marker (an HTML comment, so it shows nothing on GitHub or npm):

````markdown
<!-- snippet-test -->
```python
from zn_gate import evaluate
print(evaluate("Summarize the quarterly revenue report.").verdict)
```
````

The doc snippets steps of the `Quick checks` workflow run each marked `javascript`, `python` or `bash` block alone, against the package built from the commit (`npm pack` of `packages/zn-gate`, `packages/zn-gate-py` installed in a virtual environment), in an empty network namespace and with no API key. The block must exit 0. A failure names the file and line of the block. Mark a block only when it can run as written and offline, with no setup from a previous block, no account and no agent installed; the rest of the docs stay as they are. To try it locally: `python3 .github/scripts/doc-snippets.py list`, then `python3 .github/scripts/doc-snippets.py run` (add `--netns` on Linux with `sudo`).

## Questions and Ideas

Ask questions and share ideas in [GitHub Discussions](https://github.com/usezn/zn/discussions) rather than in issues. Open an issue for a reproducible bug or a change you are ready to propose. A vulnerability is neither: see the next section.

To install zn-gate, run `npx -y zn-gate init` in your own terminal ([Install](README.md#install)). To remove it, run `npx -y zn-gate uninstall` ([removal guide](docs/uninstall.md)).

## Security Vulnerability Reporting

If you find a security vulnerability, please do NOT open a public issue, a pull request or a discussion. Follow our [Security Policy](SECURITY.md) and report it privately: preferably with [GitHub private vulnerability reporting](https://github.com/usezn/zn/security/advisories/new), or by email to `security@usezn.com`.

## Changelog

Describe a change users will notice in a fragment file in `changelog.d/` instead of editing `CHANGELOG.md`; see [changelog.d/README.md](changelog.d/README.md).
