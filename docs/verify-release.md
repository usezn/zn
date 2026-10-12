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
| `<file>.sigstore.json` | Sigstore bundle (signature, certificate and transparency log proof) for each file, including `SHA256SUMS` |

Every file also has a GitHub artifact attestation (SLSA build provenance),
npm shows a provenance statement for the package, and PyPI stores an
attestation for each Python file.

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

In the examples below, replace `v1.5.0` / `1.5.0` with the version you are
checking.

## 1. Checksums

Download the files and `SHA256SUMS` from the
[GitHub Release](https://github.com/usezn/zn/releases), then:

```sh
sha256sum --ignore-missing -c SHA256SUMS      # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS  # macOS
```

Checksums only prove the files match `SHA256SUMS`. Check the signature on
`SHA256SUMS` (step 3) or the attestations (step 2) to know who produced it.

## 2. GitHub artifact attestations

With the [GitHub CLI](https://cli.github.com/) 2.49 or later:

```sh
gh attestation verify zn-gate-1.5.0.tgz \
  --repo usezn/zn \
  --signer-workflow usezn/zn/.github/workflows/release.yml \
  --source-ref refs/tags/v1.5.0
```

Run it for each file. It checks that the file was built by the `Release`
workflow of `usezn/zn` from that tag.

## 3. Sigstore signatures

The signing identity is the release workflow at the tag:

- identity: `https://github.com/usezn/zn/.github/workflows/release.yml@refs/tags/v1.5.0`
- issuer: `https://token.actions.githubusercontent.com`

With [sigstore-python](https://github.com/sigstore/sigstore-python):

```sh
python -m pip install sigstore
python -m sigstore verify identity \
  --bundle SHA256SUMS.sigstore.json \
  --cert-identity https://github.com/usezn/zn/.github/workflows/release.yml@refs/tags/v1.5.0 \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

With [cosign](https://github.com/sigstore/cosign) (2.4 or later; cosign 3
does not need `--new-bundle-format`):

```sh
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --new-bundle-format \
  --certificate-identity https://github.com/usezn/zn/.github/workflows/release.yml@refs/tags/v1.5.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

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
installed packages. You can also look at the attestations directly:

```sh
npm view zn-gate@1.5.0 dist.attestations
```

## 5. PyPI

Each file on [pypi.org/project/zn-gate](https://pypi.org/project/zn-gate/)
has a provenance section (open the file details under "Download files"). To
check it from the command line with
[pypi-attestations](https://github.com/pypi/pypi-attestations):

```sh
python -m pip install pypi-attestations
pypi-attestations verify pypi \
  --repository https://github.com/usezn/zn \
  pypi:zn_gate-1.5.0-py3-none-any.whl
```

## If something does not match

Do not install the files. Report it privately as described in
[SECURITY.md](../SECURITY.md).
