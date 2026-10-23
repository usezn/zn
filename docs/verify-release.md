# Verifying a zn-gate release

Every zn-gate release published by the
[`Release` workflow](../.github/workflows/release.yml) is built once from a
tag in this repository. The first such release is the first one published
after 1.5.0-beta.1 (1.5.0-beta.2 or 1.5.0, whichever comes first).
The same files are then published to npm, to PyPI and to the
GitHub Release, with no long-lived publish tokens: npm and PyPI accept them
through trusted publishing (OpenID Connect from GitHub Actions).

Each release has:

| File | What it is |
| --- | --- |
| `zn-gate-<version>.tgz` | npm package |
| `zn_gate-<pyversion>.tar.gz` | Python source distribution |
| `zn_gate-<pyversion>-py3-none-any.whl` | Python wheel |
| `SHA256SUMS` | SHA-256 checksums of the three files above |
| `zn-gate-<version>.cdx.json` | CycloneDX software bill of materials (SBOM) of the npm package (only on releases after 1.13.1, see step 7) |
| `zn_gate-<pyversion>.cdx.json` | CycloneDX SBOM of the Python package (only on releases after 1.13.1, see step 7) |
| `<file>.sigstore.json` | Sigstore bundle (signature, certificate and transparency log proof) for each file, including `SHA256SUMS` and, when a release has them, the two SBOMs |

Every file also has a GitHub artifact attestation (SLSA build provenance),
npm shows a provenance statement for the package, and PyPI stores an
attestation for each Python file.

From 1.12.0 on, the files are built, attested and signed by a separate
reusable workflow, [`build-release.yml`](../.github/workflows/build-release.yml),
whose build and signing jobs `release.yml` calls but cannot reach. That makes
the build provenance SLSA Build Level 3, and `build-release.yml` is the signer
in steps 2 and 3. Releases up to 1.11.x were built and signed by `release.yml`
itself (SLSA Build Level 2: built on a GitHub-hosted runner). The npm
provenance (step 4) and the PyPI attestations (step 5) are made when the files
are published, so for every version they name `release.yml` at the tag.

| Version | Signer workflow |
| --- | --- |
| 1.12.0 and later | `usezn/zn/.github/workflows/build-release.yml` |
| 1.5.0-beta.2 to 1.11.x | `usezn/zn/.github/workflows/release.yml` |

Python versions use the PEP 440 spelling of the npm version: `1.5.0` is
`1.5.0` on both, and `1.5.0-beta.2` on npm is `1.5.0b2` on PyPI.

**1.5.0-beta.1 and every earlier version were published by hand and have no
signatures, no attestations and no provenance.** The checks below fail for
them; that is expected and does not mean the files were tampered with. To
check one of those versions, compare it with the tagged source in this
repository.

## npm dist-tags

| Version | npm dist-tag |
| --- | --- |
| `X.Y.Z` (final, newer than the current `latest`) | `latest` |
| `X.Y.Z` (patch for an older line) | `release-X.Y` |
| `X.Y.Z-beta.N` | `beta` |
| `X.Y.Z-rc.N` | `next` |
| `X.Y.Z-alpha.N` | `alpha` |

A prerelease never moves `latest`. `npm install zn-gate` installs the latest
final release; use `npm install zn-gate@beta` (or `@next`, `@alpha`) to opt in
to a prerelease.

In the examples below, replace `v1.13.1` / `1.13.1` with the version you are
checking, and `build-release.yml` with `release.yml` for a version up to 1.11.x.
Each step says what a good result looks like, and a failed check prints an
error and ends with a non-zero exit status (`echo $?` shows it).

## 1. Checksums

Download the files, `SHA256SUMS` and the `.sigstore.json` files from the
[GitHub Release](https://github.com/usezn/zn/releases) of the version you are
checking (in the browser, or with this command, which needs no GitHub
account):

```sh
VERSION=1.13.1
for f in SHA256SUMS SHA256SUMS.sigstore.json \
  zn-gate-$VERSION.tgz zn-gate-$VERSION.tgz.sigstore.json \
  zn_gate-$VERSION-py3-none-any.whl zn_gate-$VERSION-py3-none-any.whl.sigstore.json \
  zn_gate-$VERSION.tar.gz zn_gate-$VERSION.tar.gz.sigstore.json; do
  curl -fsSLO "https://github.com/usezn/zn/releases/download/v$VERSION/$f"
done
```

Then, in the same folder (Windows has no `sha256sum`; use WSL or compare
the hashes by hand):

```sh
sha256sum --ignore-missing -c SHA256SUMS      # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS  # macOS
```

Good result: one `OK` line for each of the three files.

```text
zn-gate-1.13.1.tgz: OK
zn_gate-1.13.1.tar.gz: OK
zn_gate-1.13.1-py3-none-any.whl: OK
```

Checksums only prove the files match `SHA256SUMS`. Check the signature on
`SHA256SUMS` (step 3) or the attestations (step 2) to know who produced it.

## 2. GitHub artifact attestations

With the [GitHub CLI](https://cli.github.com/) 2.49 or later:

```sh
gh attestation verify zn-gate-1.13.1.tgz \
  --repo usezn/zn \
  --signer-workflow usezn/zn/.github/workflows/build-release.yml \
  --source-ref refs/tags/v1.13.1
```

Run it for each file. It checks that the file was built by the release
workflows of `usezn/zn` from that tag. Good result: exit status 0 (in a
terminal it also prints a check mark; with no terminal it prints nothing).

## 3. Sigstore signatures

The signing identity is the signer workflow at the tag:

- identity: `https://github.com/usezn/zn/.github/workflows/build-release.yml@refs/tags/v1.13.1`
  (up to 1.11.x: `https://github.com/usezn/zn/.github/workflows/release.yml@refs/tags/v1.11.0`)
- issuer: `https://token.actions.githubusercontent.com`

With [sigstore-python](https://github.com/sigstore/sigstore-python). On
Ubuntu and Debian the command is `python3`, and `pip` refuses to install into
the system Python, so install it into its own small folder (a virtual
environment) first. If you use [pipx](https://pipx.pypa.io/), `pipx install
sigstore` does the same and gives you a `sigstore` command to use in place of
`zn-verify/bin/python -m sigstore`:

```sh
python3 -m venv zn-verify
zn-verify/bin/pip install sigstore
zn-verify/bin/python -m sigstore verify identity \
  --bundle SHA256SUMS.sigstore.json \
  --cert-identity https://github.com/usezn/zn/.github/workflows/build-release.yml@refs/tags/v1.13.1 \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

With [cosign](https://github.com/sigstore/cosign) (2.4 or later; cosign 3
does not need `--new-bundle-format`). cosign is not in the Ubuntu package
list: download the program for your system from its
[releases page](https://github.com/sigstore/cosign/releases):

```sh
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --new-bundle-format \
  --certificate-identity https://github.com/usezn/zn/.github/workflows/build-release.yml@refs/tags/v1.13.1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Good result: sigstore prints `OK: SHA256SUMS` and cosign prints `Verified OK`.
If the identity you give is wrong, the check fails and the error shows the
identity that is really in the certificate.

A valid signature on `SHA256SUMS` plus a passing checksum check (step 1)
covers all three files. You can also verify each file against its own bundle
the same way.

## 4. npm

The package page on npmjs.com shows a provenance section that links the
version to the commit and the workflow run. From a project where zn-gate is
installed:

```sh
npm audit signatures
```

It checks the registry signatures and the provenance attestations of the
installed packages (zn-gate and what it ships with). Good result: lines such
as `9 packages have verified registry signatures` and `9 packages have
verified attestations`; the number depends on your project. In a folder where
nothing is installed it says `found no installed dependencies to audit`. You
can also look at the attestations directly:

```sh
npm view zn-gate@1.13.1 dist.attestations
```

Good result: an object with a `url` for the attestations and a `provenance`
entry whose `predicateType` is `https://slsa.dev/provenance/v1`.

## 5. PyPI

Each file on [pypi.org/project/zn-gate](https://pypi.org/project/zn-gate/)
has a provenance section (open the file details under "Download files"). To
check it from the command line with
[pypi-attestations](https://github.com/pypi/pypi-attestations). Install it
into a virtual environment as in step 3 (or with `pipx install
pypi-attestations`):

```sh
python3 -m venv zn-verify-pypi
zn-verify-pypi/bin/pip install pypi-attestations
zn-verify-pypi/bin/pypi-attestations verify pypi \
  --repository https://github.com/usezn/zn \
  pypi:zn_gate-1.13.1-py3-none-any.whl
```

Good result: `OK: zn_gate-1.13.1-py3-none-any.whl`. This check downloads the
file from PyPI itself, so it needs an internet connection and does not use
the file you downloaded in step 1.

## 6. The release tag

From 1.12.0 on, the tag `vX.Y.Z` is created and signed by the
[`Tag release` workflow](../.github/workflows/tag-release.yml) with
[gitsign](https://github.com/sigstore/gitsign) (Sigstore keyless signing): the
signature names that workflow, not a person, and the Release workflow refuses
to publish a tag of such a commit without that signature. gitsign is not in
the Ubuntu package list: download the program for your system from its
[releases page](https://github.com/sigstore/gitsign/releases). With gitsign
0.17 or later, in a clone of this repository:

```sh
git fetch origin tag v1.13.1
gitsign verify-tag v1.13.1 \
  --certificate-identity https://github.com/usezn/zn/.github/workflows/tag-release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Good result: the output ends with these lines (the `tlog index` number
differs):

```text
Good signature from [https://github.com/usezn/zn/.github/workflows/tag-release.yml@refs/heads/main]
Validated Git signature: true
Validated Rekor entry: true
Validated Certificate claims: true
```

Use `gitsign verify-tag`, not `git verify-tag`: plain git looks for a GPG
key, cannot read this kind of signature and prints a confusing
`ksba_cms_parse failed: Invalid CMS object` error.

Tags up to 1.11.x are not signed.

## 7. SBOM (software bill of materials)

Releases up to and including 1.13.1 have no SBOM files: the release build
did not write them yet. The build now does, so every release after 1.13.1
has a [CycloneDX](https://cyclonedx.org/) 1.6 SBOM for the npm package
(`zn-gate-<version>.cdx.json`) and one for the Python package
(`zn_gate-<pyversion>.cdx.json`; zn-gate has no Python dependencies, so it lists
only the package itself). Both are attached to the GitHub Release (look at its
file list: if there is no `.cdx.json` file, that release has no SBOM, and the
commands below fail with a "not found" error). The release workflow attests
each SBOM against the package it describes, so you can check
that the list was produced by the release build and belongs to the file you
downloaded.

With the GitHub CLI 2.49 or later, for the npm package of a release that has
SBOMs (use the `.whl` or `.tar.gz` file for the Python one). Replace
`<version>` with that version:

```sh
gh attestation verify zn-gate-<version>.tgz \
  --repo usezn/zn \
  --signer-workflow usezn/zn/.github/workflows/build-release.yml \
  --source-ref refs/tags/v<version> \
  --predicate-type https://cyclonedx.org/bom
```

To see that the attested SBOM is the file attached to the release, print the
attested document and compare it with the downloaded one:

```sh
gh attestation verify zn-gate-<version>.tgz \
  --repo usezn/zn \
  --predicate-type https://cyclonedx.org/bom \
  --format json --jq '.[].verificationResult.statement.predicate' > attested.cdx.json
diff <(jq -S . attested.cdx.json) <(jq -S . zn-gate-<version>.cdx.json) && echo "same SBOM"
```

The SBOM files also have build provenance attestations and Sigstore bundles
(steps 2 and 3), so `gh attestation verify zn-gate-<version>.cdx.json --repo usezn/zn`
works on them too.

## If something does not match

Do not install the files. Report it privately as described in
[SECURITY.md](../SECURITY.md).
