# Security Policy

## Supported Versions

Security fixes are released for the latest minor version of `zn-gate` (npm and PyPI).
Upgrade to it to receive them.

| Version | Supported          |
| ------- | ------------------ |
| 1.7.x   | :white_check_mark: |
| < 1.7.0 | :x:                |

Prereleases (`-alpha`, `-beta`, `-rc`) are not supported once the final release is out.

---

## Reporting a Vulnerability

We take the security of zn, the MCP Gateway, and our client SDKs seriously. If you have discovered a security vulnerability, please report it to us privately. Do not open a public issue or pull request.

* **Preferred: GitHub private vulnerability reporting.** Open the [Security tab](https://github.com/usezn/zn/security) of this repository and click **Report a vulnerability** ([direct link](https://github.com/usezn/zn/security/advisories/new)). The report stays private between you and the maintainers, and we can work on the fix and the advisory with you there.
* **Alternative: email** [security@usezn.com](mailto:security@usezn.com), for example if you do not have a GitHub account or the issue affects the usezn.com platform rather than this repository.

Please include detailed reproduction steps, proof-of-concept payloads or scripts, and affected versions, components or commits. Testing against local Docker containers or isolated test accounts is strongly encouraged.

### What to expect

The project has a single maintainer today (see [MAINTAINERS.md](MAINTAINERS.md)). These are targets, for both channels:

| Step | Target |
| --- | --- |
| Acknowledge your report | within 3 business days |
| Initial assessment and severity (CVSS) | within 7 days |
| Fix released, critical or high severity | within 30 days |
| Fix released, medium or low severity | within 90 days |

We keep you updated at least every 14 days until the issue is resolved, and tell you if a target will be missed and why.

---

## Coordinated Disclosure

1. **Private triage.** We confirm the issue, assess its severity and affected versions, and open a draft GitHub Security Advisory (or use the one you opened through private vulnerability reporting). You are invited to it.
2. **CVE.** For an issue in a released package, we request a CVE through GitHub from the advisory.
3. **Fix.** For a reported issue, the fix is developed and reviewed privately (for example in the advisory's temporary private fork), with tests that reproduce the issue. For an issue we find ourselves and can fix right away, the fix may go through public pull requests and be released within hours. For a patch release we ship only the fixes it needs, from a `release/X.Y.Z` branch (see [GOVERNANCE.md](GOVERNANCE.md)).
4. **Release.** The fixed version is published to npm and PyPI by the [`Release` workflow](.github/workflows/release.yml), with signatures and provenance.
5. **Disclosure.** We publish the advisory, the release notes and the changelog entry together: affected versions, impact, what to do, and credit to the reporter (unless you prefer to stay anonymous). Advisories describe the class of problem, not step-by-step exploitation.

We ask you to keep the details private until the advisory is published, and we aim to publish within 90 days of your report. If a fix needs longer, we agree a date with you; if the issue is being exploited, we may publish earlier with mitigations.

Example: [GHSA-rf3f-ppm5-3xrx](https://github.com/usezn/zn/security/advisories/GHSA-rf3f-ppm5-3xrx) (`zn run` on Windows) was found in an internal review. The fixes were merged through pull requests, cherry-picked onto a `release/1.5.1` branch made from `main`, published as 1.5.1 through the release workflow, and disclosed with the advisory and the release notes on the same day.

---

## Verifying Releases

Starting with the first release after 1.5.0-beta.1, the npm and PyPI packages are built and published by the [`Release` workflow](.github/workflows/release.yml) with trusted publishing; no long-lived publish tokens are used. 1.5.0-beta.1 and earlier versions were published by hand and have no signatures, attestations or provenance. Each GitHub Release from the workflow includes `SHA256SUMS` and Sigstore bundles, every file has a GitHub build provenance attestation, and npm and PyPI show provenance for each version. Step-by-step checks: [docs/verify-release.md](docs/verify-release.md).

---

## Safe Harbor

We consider security research conducted in accordance with this policy to be authorized. If you make a good-faith effort to avoid privacy violations, data destruction, and service interruption, we commit to:
* Not pursuing legal action against you.
* Working with you transparently to understand and validate the issue.
* Publicly acknowledging your contribution (unless you prefer anonymity).

---

## Security Hall of Fame

We gratefully acknowledge independent security researchers who have helped protect the zn ecosystem through coordinated, responsible disclosure:

| Date | Identifier | Summary | Researcher |
| :--- | :--- | :--- | :--- |
| **2026-09-07** | [SEC-2026-01](docs/advisories/SEC-2026-01.md) | Control-plane authorization gap on policy and consensus handlers | **[WinstonRedGuard (github.com/WRG-11)](https://github.com/WRG-11)** |
| **2026-09-30** | [SEC-2026-02](docs/advisories/SEC-2026-02.md) | Insufficient session and token revocation on password reset (CWE-613) | **[Ganesh RK](https://www.linkedin.com/in/ganesh-rk-6b827828a/)** |
| **2026-10** | [SEC-2026-03](https://usezn.com/security/) | Incomplete session revocation on password change (CWE-613 follow-up) | **[Akshay Gore](https://www.linkedin.com/in/akshay-gore-512737345/)** |
| **2026-10** | [SEC-2026-04](https://usezn.com/security/) | Session termination flow hardening (logout redirects & error handling) | **Sudarshan Dhanvai** |

---

## Security Advisories

* [GHSA-wvv2-f3m6-6wrq](https://github.com/usezn/zn/security/advisories/GHSA-wvv2-f3m6-6wrq) — *zn-gate for Node.js: an agent could run zn admin commands through a versioned package call (`npx -y zn-gate@<version> ...`), skipping the hook that denies them (fixed in 1.6.0)*
* [GHSA-rf3f-ppm5-3xrx](https://github.com/usezn/zn/security/advisories/GHSA-rf3f-ppm5-3xrx) — *zn-gate for Node.js on Windows: `zn run` could hand secrets to a program chosen through the environment (fixed in 1.5.1)*
* [GHSA-r4h2-qcf2-8227](https://github.com/usezn/zn/security/advisories/GHSA-r4h2-qcf2-8227) — *zn-gate 1.4.0 and earlier sent tool output and tool-call arguments to api.usezn.com without redaction when `ZN_API_KEY` was set (fixed in 1.4.1)*
* [SEC-2026-01](docs/advisories/SEC-2026-01.md) — *Control-plane authorization gap in zn management API (Remediated in commit 6ebce2f)*
* [SEC-2026-02](docs/advisories/SEC-2026-02.md) — *Insufficient session and token revocation on password reset (Remediated in the usezn.com platform, which is not part of this repository)*
* [SEC-2026-03](https://usezn.com/security/) — *Incomplete session revocation on password change (Remediated in the usezn.com platform, which is not part of this repository)*
* [SEC-2026-04](https://usezn.com/security/) — *Session termination flow hardening: logout redirects and error handling (Remediated in the usezn.com platform, which is not part of this repository)*
