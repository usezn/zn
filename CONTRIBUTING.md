# Contributing to zn

Thank you for your interest in contributing to **zn**! We welcome bug reports, rule improvements, security research, and pull requests.

How the project is maintained, how pull requests are reviewed and how releases are made: [GOVERNANCE.md](GOVERNANCE.md). Pull requests target the `next` branch.

## Architecture Overview

`zn` is designed as a local-first security gate with minimal dependencies:
- `packages/zn-gate/`: Node.js SDK, CLI, MCP Server, and stdio Shield proxy. Its only runtime dependency is `age-encryption` (with its `@noble`/`@scure` dependencies) for the secret vault, bundled in the package.
- `packages/zn-gate-py/`: Python SDK, CLI, and agent framework integrations (Python standard library only).
- `src/`: legacy Rust gateway (see [docs/rust-core.md](docs/rust-core.md)); not released and not built in CI.

## Development Setup

### Prerequisites
- Node.js >= 18.0.0
- Python >= 3.8
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

## Adding New Rules

When adding new detection rules:
1. Ensure the rule ID follows naming conventions (`pi:name`, `evasion:name`, `exfil:name`, `indirect:name`).
2. Add the rule to **both** `packages/zn-gate/lib/rules.js` and `packages/zn-gate-py/src/zn_gate/rules.py`.
3. Bump `RULES_VERSION` in both packages.
4. Add positive test cases (attack vectors that must be blocked) and negative test cases (benign developer code that must be allowed).
5. Verify zero false positives against real technical text (SQL, React, Docker, shell scripts).

## Rule Versions and the Snapshot

Each rule layer has a version constant: `RULES_VERSION` (detection rules, both packages), `SCRUB_RULES_VERSION` (secret and PII types), `AUDIT_RULES_VERSION` (`zn audit` rules) and `POLICY_RULES_VERSION` (hook policy). When you change a layer:

1. Bump its version in the format `YYYY-MM-DD.N` (increase `N` for a second change on the same day).
2. Run `node packages/zn-gate/scripts/update-rules-snapshot.js`. It rewrites `packages/zn-gate/test/fixtures/rules_snapshot.json` and refuses to write when a file changed without a version bump.
3. Commit the updated snapshot with the change. `npm test` in `packages/zn-gate` runs `test/rules_snapshot.test.js`, which fails on any mismatch.

CI also runs the false-positive gate, `node bench/rules_fp_gate.js`. It counts the blocks over the benign corpus and over `packages/zn-gate/test/fixtures/benign_phrases.json`, and fails when any rule blocks more than the committed baseline in `bench/rules_fp_baseline.json`. If your change must block more benign text, explain why in the pull request, then run `node bench/rules_fp_gate.js --update-baseline`. Changing the phrase list also changes the scanned count, so update the baseline in the same commit.

## Security Vulnerability Reporting

If you find a security vulnerability, please do NOT open a public issue. Follow our [Security Policy](SECURITY.md) and report it to `security@usezn.com`.
