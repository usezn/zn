# Contributing to zn

Thank you for your interest in contributing to **zn**! We welcome bug reports, rule improvements, security research, and pull requests.

How the project is maintained, how pull requests are reviewed and how releases are made: [GOVERNANCE.md](GOVERNANCE.md). Pull requests target the `next` branch. Releases ship weekly: a pull request merged into `next` by Thursday goes into that week's release candidate and, after testing, into the release on Tuesday ([release schedule](GOVERNANCE.md#release-schedule)).

## Architecture Overview

`zn` is designed as a local-first security gate with minimal dependencies:

- `packages/zn-gate/`: Node.js SDK, CLI, MCP Server, and stdio Shield proxy. Its only runtime dependency is `age-encryption` (with its `@noble`/`@scure` dependencies) for the secret vault, bundled in the package.
- `packages/zn-gate-py/`: Python SDK, CLI, and agent framework integrations (Python standard library only).
- `src/`: legacy Rust gateway (see [docs/rust-core.md](docs/rust-core.md)); not released as a package. CI builds, tests and lints it ([rust.yml](.github/workflows/rust.yml)).

## Development Setup

These steps were tested on a clean Ubuntu 24.04. Where macOS differs, there is one line for it. On Windows, use WSL with Ubuntu.

### Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Git | any recent | everything |
| Node.js and npm | 22 (CI uses 22; the package itself runs on 18 or later) | the Node.js package, the CI checks that run on Node.js |
| Python | 3.10 or later (CI uses 3.12) | the Python package |
| Rust | 1.99.0 (the minimum supported is 1.95) | the legacy Rust gateway only |
| `protoc` | 29.3 in CI (an older one, such as 3.21, also builds it) | the legacy Rust gateway only |

You only need the tools for the part you change. Node.js 20 or later is required for the Markdown linter, so use 22 if you can.

Install them on Ubuntu 24.04:

```bash
sudo apt update
sudo apt install -y git curl build-essential python3-venv python3-pip protobuf-compiler
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

The Ubuntu package for Node.js is version 18, which is too old for the Markdown linter. The NodeSource lines above install version 22. On macOS: `brew install node@22 python@3.12 protobuf`.

Then get the code:

```bash
git clone https://github.com/usezn/zn.git
cd zn
git switch next
git switch -c my-change
```

Fork the repository first if you want to push your branch. Git needs a name and an email before it can commit. Use any name, and the no-reply address that GitHub shows in your email settings if you do not want to publish your own:

```bash
git config user.name "Your Name"
git config user.email "your-id+your-user@users.noreply.github.com"
```

### Node.js (`packages/zn-gate`)

```bash
cd packages/zn-gate
npm ci --ignore-scripts
npm test
```

`npm ci` installs the exact dependencies. Without it, the vault tests fail with `Cannot find package 'age-encryption'`. `npm test` runs the full unit test suite, the shield proxy tests, the auto-shielding init tests, the cryptographic evidence tests, and the 51-vector self-test suite. It takes a few minutes.

### Python (`packages/zn-gate-py`)

Ubuntu 24.04 does not let you install packages into the system Python, so use a virtual environment. Run these commands from the root of the repository:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --require-hashes -r .github/ci-test-requirements.txt
pip install --no-deps -e packages/zn-gate-py
cd packages/zn-gate-py
python -m pytest tests/ -v
```

`.github/ci-test-requirements.txt` holds pytest, hypothesis, ruff, mypy and the other test tools, pinned with hashes. The package itself has no dependencies. In a new terminal, run `source .venv/bin/activate` again from the root of the repository. The `.venv` folder is ignored by git.

The tests that use the LangChain and LlamaIndex integrations skip when those packages are not installed. CI installs them. To run them too: `pip install --require-hashes -r .github/ci-framework-test-requirements.txt`.

### Rust (legacy gateway, optional)

Only needed if you change files in `src/`. Install Rust with rustup (on macOS too), then run the same commands CI runs, from the root of the repository:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.99.0 --component clippy --component rustfmt
. "$HOME/.cargo/env"
cargo build --locked
cargo test --locked
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
```

The build needs a C compiler (`build-essential` on Ubuntu, Xcode command line tools on macOS) and `protoc`. The first build takes a few minutes.

## Adding New Rules

When adding new detection rules:

1. Ensure the rule ID follows naming conventions (`pi:name`, `evasion:name`, `exfil:name`, `indirect:name`).
2. Add the rule to **both** `packages/zn-gate/lib/rules.js` and `packages/zn-gate-py/src/zn_gate/rules.py`.
3. Bump `RULES_VERSION` in both packages.
4. Add positive test cases (attack vectors that must be blocked) and negative test cases (benign developer code that must be allowed).
5. Verify zero false positives against real technical text (SQL, React, Docker, shell scripts).

## Rule Versions and the Snapshot

Each rule layer has a version constant that must increase whenever the layer's rules change:

| Layer | Constant | Files covered by the snapshot |
| --- | --- | --- |
| Detection rules | `RULES_VERSION` | `lib/rules.js`, `lib/mcp-secrets.js` |
| Scrubber types | `SCRUB_RULES_VERSION` | `lib/scrub/patterns.js`, `lib/scrub/exact.js` |
| `zn audit` | `AUDIT_RULES_VERSION` | `lib/audit/rules.js`, `lib/audit/patterns.js` |
| Hook policy | `POLICY_RULES_VERSION` | `lib/hooks/policy.js`, `lib/broker/files.js`, `lib/broker/markers.js`, `lib/broker/dotenv.js`, `lib/shell-quote.js` |

The Python `rules.py` and `mcp_secrets.py` are not in the snapshot. The parity test (`test/rules_parity.test.js`) keeps `rules.py` equal to `rules.js`; `mcp_secrets.py` is kept equal to `lib/mcp-secrets.js` by the shared samples in `test/fixtures/mcp_config_secret_samples.json`, which both test suites run.

When you change a layer:

1. Bump its version in the format `YYYY-MM-DD.N`. The version must increase. Dates compare as text and `N` compares as a number, so `2026-10-14.10` is newer than `2026-10-14.9`. Adding or removing a file in a layer counts as a change.
2. Run `node packages/zn-gate/scripts/update-rules-snapshot.js`. It rewrites `packages/zn-gate/test/fixtures/rules_snapshot.json` and refuses to record a change whose version did not increase.
3. Commit the updated snapshot with the change. `npm test` in `packages/zn-gate` runs `test/rules_snapshot.test.js`. It fails on a changed file with the same or an older version, on a version that moved without a file change, and on rule ids that were added or removed.

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

The `Doc snippets` workflow runs each marked `javascript`, `python` or `bash` block alone, against the package built from the commit (`npm pack` of `packages/zn-gate`, `packages/zn-gate-py` installed in a virtual environment), in an empty network namespace and with no API key. The block must exit 0. A failure names the file and line of the block. Mark a block only when it can run as written and offline, with no setup from a previous block, no account and no agent installed; the rest of the docs stay as they are. To try it locally: `python3 .github/scripts/doc-snippets.py list`, then `python3 .github/scripts/doc-snippets.py run` (add `--netns` on Linux with `sudo`).

## Checks CI runs on your pull request

Your pull request must pass these checks. Each one has a command you can run first. Run them from the root of the repository unless the table says otherwise.

| Check | Runs when you change | Local command |
| --- | --- | --- |
| Node.js tests and lint | `packages/zn-gate` | `cd packages/zn-gate && npm ci --ignore-scripts && npm test`, then the lint steps below |
| Python tests, ruff and mypy | `packages/zn-gate-py` | see the Python section, then the lint steps below |
| Rust format, clippy, build and test | `src/`, `Cargo.toml` | see the Rust section |
| Markdown lint | `docs/`, the README files, `changelog.d/README.md` | see below |
| Typos | the same prose, and `changelog.d/` | see below |
| Changelog | shipped files | see below |
| Public facts | the README files, the docs, or the numbers they quote | `node --test .github/scripts/check-public-facts.test.mjs && node .github/scripts/check-public-facts.mjs` |
| False-positive gate | detection rules | see below |
| Doc snippets | marked code blocks in the docs | see [Runnable doc snippets](#runnable-doc-snippets) |
| Pre-commit hooks | `.pre-commit-hooks.yaml` | `pip install pre-commit==4.2.0 PyYAML` in your virtual environment, then `bash .github/scripts/test-pre-commit-hooks.sh` |

CI decides from the files you changed which checks it needs to run, so a docs-only change does not run the Rust checks.

Lint for the code:

```bash
# Node.js (eslint)
npm ci --ignore-scripts --prefix .github/eslint
cd packages/zn-gate
../../.github/eslint/node_modules/.bin/eslint -c ../../.github/eslint/eslint.config.mjs --max-warnings 0 .
cd ../..

# Python (ruff and mypy; the virtual environment must be active)
cd packages/zn-gate-py
python -m ruff check .
python -m mypy
cd ../..
```

Markdown lint needs Node.js 20 or later:

```bash
npm ci --ignore-scripts --no-audit --no-fund --prefix .github/markdownlint
.github/markdownlint/node_modules/.bin/markdownlint-cli2
```

Typos (the virtual environment must be active):

```bash
pip install typos
typos --config .typos.toml docs README.md packages/zn-gate/README.md packages/zn-gate-py/README.md changelog.d
```

If `typos` flags a word that is correct, such as a product name, add it to `.typos.toml` with the reason next to it.

False-positive gate. The corpus is downloaded once and checked against fixed hashes. Without it, the gate skips most of its work and prints a warning:

```bash
bash packages/zn-gate/test/fixtures/benign/fetch_corpus.sh
node bench/rules_fp_gate.js
```

Changelog. A change that users will notice needs a fragment in `changelog.d/`, named after your branch. Do not edit `CHANGELOG.md` by hand. A change that users do not notice, such as a fix in this file, takes the `no-changelog` label instead. A maintainer adds the label, so ask for it in the pull request description. The rules and the fragment format are in [changelog.d/README.md](changelog.d/README.md). To check your branch:

```bash
node --test .github/scripts/changelog.test.mjs
node .github/scripts/changelog.mjs check --base origin/next
```

The check fails when shipped files changed without a fragment. It does not fail for a docs-only change; the files it counts as shipped are the packages, the plugin and the Action.

## Questions and Ideas

Ask questions and share ideas in [GitHub Discussions](https://github.com/usezn/zn/discussions) rather than in issues. Open an issue for a reproducible bug or a change you are ready to propose.

## Security Vulnerability Reporting

If you find a security vulnerability, please do NOT open a public issue. Follow our [Security Policy](SECURITY.md) and report it to `security@usezn.com`.

## Changelog

Describe a change users will notice in a fragment file in `changelog.d/` instead of editing `CHANGELOG.md`; see [changelog.d/README.md](changelog.d/README.md).
