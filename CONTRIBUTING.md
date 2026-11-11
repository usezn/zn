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

## For first-time contributors

A short list of what a pull request needs. Each step points to the section below that explains it.

1. Have Node.js 18 or later and Python 3.10 or later ([Prerequisites](#prerequisites)).
2. Open your pull request against the `next` branch.
3. Run the Node.js tests: `cd packages/zn-gate`, then `npm test` ([Running Tests Locally](#running-tests-locally)).
4. If you changed the Python package, run its tests too: `python -m pip install -e .`, then `python -m pytest tests/ -v` in `packages/zn-gate-py`.
5. If you changed a detection rule, change it in both packages, add a positive and a negative test case, and bump the version ([Adding New Rules](#adding-new-rules), [Rule Versions and the Snapshot](#rule-versions-and-the-snapshot)).
6. If users will notice the change, add a fragment file in `changelog.d/` and leave `CHANGELOG.md` alone ([Changelog](#changelog)).
7. Update the docs that the change touches, and keep any marked snippet runnable ([Runnable doc snippets](#runnable-doc-snippets)).
8. Keep secrets, tokens, keys and personal data out of the diff, the commit messages and the test fixtures. Do not force-push to a shared branch.
9. Report a security vulnerability privately, never in a public issue or pull request ([Security Vulnerability Reporting](#security-vulnerability-reporting)).

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

## Continuous integration (CI)

Each pull request into `next` runs automated checks on GitHub. Eleven checks are **required**, and a pull request cannot merge until all of them pass. These are the names you see on the pull request:

- Node.js 18.x tests & benchmarks
- Node.js 22.x tests & benchmarks
- Node.js 24.x tests & benchmarks
- Python 3.12 tests & benchmarks (ubuntu-latest)
- Python package (build, twine check, install)
- npm package (pack, inspect, install)
- leak bench (node 22 / ubuntu-latest)
- scrubber + vault (node 22 / ubuntu-latest)
- Lint (eslint, ruff, mypy)
- Public facts
- build, test, clippy, fmt

To keep pull requests fast, a pull request into `next` runs only the Node.js 22.x tests. The 18.x and 24.x checks report success at once and run for real in the merge queue. A pull request that changes only documentation skips most code checks, which also report success.

Only `next` has a merge queue; `main` does not. When a maintainer adds an approved pull request to the queue, the queue builds it on top of the pull requests ahead of it, runs the required checks on that combined result, and merges up to five pull requests at a time, in order. If a required check fails there, the pull request leaves the queue. Fix the problem, push a commit, and ask a maintainer to queue it again.

Nine more checks are **not required**, so they do not block a merge: Changelog, Markdown lint, Typos, Link check, Shellcheck, Workflow lint, Package lint, Pre-commit hooks and Doc snippets. They check the changelog entry, Markdown, spelling, links, shell scripts, package files and the code samples in the docs. A failure there does not block the merge, but fix it before review if you can.

If a check fails, open it from the Checks tab of the pull request. The first failed step shows the problem.

Checks run again each time you push a commit, and a new push cancels a run still in progress. Without write access you cannot rerun a check yourself, so push a new commit to get a fresh run, for example an empty one with `git commit --allow-empty -m "Rerun checks"`. A maintainer with write access can open the run and choose "Re-run failed jobs".

For what each check covers and how to run it on your own machine, see [Run the required checks locally](#run-the-required-checks-locally).

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

### Check docs links before you push

If you add or move a page, or link to a heading, check the links on your machine first. A broken link fails the pull request.

- Two Node.js tests cover the pages under `docs/`: `test/docs_relative_links.test.js` (a relative link points to a file that exists) and `test/docs_anchor_links.test.js` (a link to a `#section` names a heading that exists). They need no install:

  ```bash
  cd packages/zn-gate
  node --test test/docs_relative_links.test.js test/docs_anchor_links.test.js
  ```

- The offline link check CI runs, with lychee, covers the READMEs and `plugins` too. The command is in item 3 of the Documentation checks above.

## Writing a CI check script

The small checks of the [Quick checks workflow](.github/workflows/quick-checks.yml) are plain Node.js scripts in `.github/scripts/`, one `check-<name>.mjs` with a `check-<name>.test.mjs` next to it. Real ones to copy from: `check-timeouts.mjs` (every workflow job sets `timeout-minutes`), `check-workflow-header.mjs`, `check-docs-titles.mjs` and `check-docs-examples-commands.mjs`. Follow the same shape so that a failure reads the same everywhere.

1. **Write the script** as `.github/scripts/check-<name>.mjs`:
   - Start with a comment that says what makes the check fail and how to run it, with the default arguments.
   - Use only `node:` imports; no packages are installed for these checks.
   - Put the logic in exported functions that take text or a folder and return the problems, so a test can call them. Keep `main(argv)` small: it returns the exit code.
   - Run `main` only when the file is run directly, as the existing scripts do (`import.meta.url` compared with `process.argv[1]`), and wrap it so that an unexpected error prints `check-<name>: <message>` and exits with `1`.
2. **Exit codes and messages.** Exit `0` and print one line that says what was checked, for example `timeouts OK: every job in 12 workflow file(s) sets timeout-minutes`. Exit `1` when there is a problem: print one line per problem that names the file and, where it can, the line or the job (`<file>:<line>: <problem>`), then an empty line and one sentence that says how to fix it. Print problems on standard error.
3. **Write the test** as `.github/scripts/check-<name>.test.mjs` with `node:test` and `node:assert/strict`. Cover an input that passes, one that fails with the exact message, and the edge that made you write the check. Use a temporary folder for the file-based case. Run it with `node --test .github/scripts/check-<name>.test.mjs`.
4. **Add two steps to the job in `.github/workflows/quick-checks.yml`**, next to the other checks: one that runs the test and one that runs the check. Both use `if: ${{ !cancelled() && steps.scope.outputs.<name> == 'true' }}`, so a failing step does not hide the ones after it. If your check is the only reason Node.js is needed for a change, add the same output to the `if:` of the `setup-node` step.
5. **Decide when it runs in `.github/scripts/quick-scope.sh`.** Add `<name>` to the `CHECKS` list and to the comment at the top, and add a `case` branch that sets `run[<name>]=true` for the paths that should trigger it (the script and its test, plus the files it reads). A change to `quick-checks.yml` or to `quick-scope.sh` itself runs every check.
6. **Test the scope.** Add one `check pull_request next <path> "<checks that must run>"` line to `.github/scripts/test-quick-scope.sh` for each path you added, and update the existing lines that now run your check too (the line for `quick-checks.yml` lists every check). Run `bash .github/scripts/test-quick-scope.sh` from the repository root.

Before you push, run the new script and its test on your own machine, then the [documentation checks](#documentation-checks) and the other checks that your change touches. The Quick checks are not among the required checks, so a maintainer decides if a new one should become required (that needs a change to the branch rules and a `merge_group` trigger, see the comment at the top of `quick-checks.yml`).

## Your first pull request and draft pull requests

- The first pull request from a fork waits for a maintainer to approve the workflow runs. The repository requires this approval for every outside contributor, so the checks show as waiting until a maintainer selects "Approve and run". Nothing is wrong with your change.
- A draft pull request does not run the required checks, except Public facts. They stay pending until you mark the pull request as ready for review; then they start.

## For package maintainers

The npm package (`packages/zn-gate`) and the Python package (`packages/zn-gate-py`) are meant to give the same verdicts and the same redaction. When you change a rule, a verdict or the way a secret is redacted in one package, make the matching change in the other and run both test suites (see [Running Tests Locally](#running-tests-locally)).

These Python tests compare the two packages. Most of them need the full repository checkout and a `node` binary, and are skipped with a message when either is missing (for example when testing an sdist):

- `packages/zn-gate-py/tests/test_rules_parity.py` (with `packages/zn-gate/test/rules_parity.test.js`): the Python rules must equal the Node.js rules, checked on the shared samples in `packages/zn-gate/test/fixtures/rules_parity_samples.json`.
- `packages/zn-gate-py/tests/test_tool_guard_parity.py`: the tool-call and tool-result guards must give the same verdicts as the Node.js guard on `packages/zn-gate/test/fixtures/tool_guard_parity.json`.
- `packages/zn-gate-py/tests/test_secret_scrub_parity.py`: both engines must name the same secrets in the same places, apart from the cases listed there with a reason.
- `packages/zn-gate-py/tests/test_redaction_parity_fuzz.py`: seeded random texts with fake keys must come out with no key visible from either engine.
- `packages/zn-gate-py/tests/test_benign_corpus_parity.py`: the Python destructive-command check must decide each everyday command in `packages/zn-gate/test/fixtures/benign-commands.txt` as the Node.js package does.
- `packages/zn-gate-py/tests/test_cli_node_parity.py`: the Python and Node.js command lines agree on the version and on basic exit codes.

CI also runs `node .github/scripts/check-rule-versions.mjs`, which fails when the two packages disagree on `RULES_VERSION` or `COMMAND_RULES_VERSION` (see [Rule Versions and the Snapshot](#rule-versions-and-the-snapshot)).

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
