# Benign corpus (downloaded, not committed)

Real, permissively licensed code used by `bench/leak_bench.js` to measure
over-redaction of the scrubber engine. The files are **not** stored in this
repository: they are downloaded from pinned, immutable sources and verified
against `MANIFEST.json` (one sha256 per file), so every run gets the exact
same bytes.

## Fetch and verify

    bash packages/zn-gate/test/fixtures/benign/fetch_corpus.sh

The script downloads the pinned sources, extracts them, and fails on any
checksum mismatch. On Windows use Git Bash (CI runs it with `shell: bash`).

## Pinned sources

| id | origin | license |
| --- | --- | --- |
| `python-stdlib` | CPython `v3.14.8` source tag, `Lib/**/*.py` excluding `Lib/test` | PSF-2.0 |
| `npm:lodash@4.17.21` | npm registry tarball | MIT |
| `npm:async@3.2.6` | npm registry tarball | MIT |

Both npm tarballs are immutable on the registry; the GitHub source tag is
immutable as well. The sha256 pin in `MANIFEST.json` is what makes the corpus
byte-reproducible even if a source ever changed.

Paths that this repository's ignore rules would hide (`Lib/venv/`, the npm
`dist/` directories, ...) are excluded by `fetch_corpus.sh`, so the downloaded
tree and `MANIFEST.json` always describe exactly the same files. If the
`MANIFEST.json` check fails, the sources no longer match the pin: re-download
with `fetch_corpus.sh`, and only regenerate the manifest as a maintainer
action (`PY_TAG=... node build_manifest.js`) together with a pin change.

## Layout

- `python-stdlib/`, `npm/`, `licenses/` — downloaded at fetch time (git-ignored)
- `MANIFEST.json` — source, license and sha256 of every corpus file
- `fetch_corpus.sh` — download, extract and verify
- `build_manifest.js` — regenerate the manifest (maintainers) or verify it
  (`node build_manifest.js --verify`)
