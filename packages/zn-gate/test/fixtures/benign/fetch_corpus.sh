#!/usr/bin/env bash
# Fetches the pinned benign corpus used by bench/leak_bench.js and verifies
# every file against MANIFEST.json (one sha256 per file). The sources are
# immutable and the file set is deterministic, so every run produces the
# exact same bytes; any mismatch fails the script.
#
# Deterministic exclusions: Lib/venv/ and the npm dist/ directories are left
# out because this repository's global .gitignore hides paths with those
# names; the fetched tree, MANIFEST.json and a checkout view must always
# agree on the same file set. Lib/test is excluded as well: test suites are
# not representative benign code.
#
# Pinned sources:
#   - CPython v3.14.8 source tag, Lib/**/*.py except Lib/test and Lib/venv (PSF-2.0)
#   - lodash@4.17.21 (MIT), async@3.2.6 (MIT) from the npm registry
#
# Usage:  bash fetch_corpus.sh
# Needs:  bash, curl, tar, node >= 18. On Windows use Git Bash (CI runs it
#         with `shell: bash`).
set -euo pipefail

DEST="$(cd "$(dirname "$0")" && pwd)"
PY_TAG="v3.14.8"
NPM_PACKAGES=("lodash@4.17.21" "async@3.2.6")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== fetching CPython $PY_TAG sources"
mkdir -p "$TMP/cpython"
curl -fsSL "https://github.com/python/cpython/archive/refs/tags/$PY_TAG.tar.gz" \
  | tar -xz -C "$TMP/cpython" --strip-components=1 "cpython-${PY_TAG#v}/Lib" "cpython-${PY_TAG#v}/LICENSE"

rm -rf "$DEST/python-stdlib" "$DEST/npm" "$DEST/licenses"
mkdir -p "$DEST/licenses"

echo "== copying Lib/**/*.py (excluding Lib/test and Lib/venv)"
(cd "$TMP/cpython/Lib" && find . -name '*.py' ! -path './test/*' ! -path './venv/*' -type f | sed 's|^\./||' | sort) \
  | while IFS= read -r rel; do
      mkdir -p "$DEST/python-stdlib/$(dirname "$rel")"
      cp "$TMP/cpython/Lib/$rel" "$DEST/python-stdlib/$rel"
    done
cp "$TMP/cpython/LICENSE" "$DEST/licenses/cpython-$PY_TAG-LICENSE.txt"

echo "== fetching npm packages"
for spec in "${NPM_PACKAGES[@]}"; do
  name="${spec%@*}"
  ver="${spec##*@}"
  echo "   $name@$ver"
  mkdir -p "$TMP/pkg-$name"
  curl -fsSL "https://registry.npmjs.org/$name/-/$name-$ver.tgz" | tar -xz -C "$TMP/pkg-$name" --strip-components=1
  (cd "$TMP/pkg-$name" && find . -type f ! -path '*/dist/*' | sed 's|^\./||' | sort) \
    | while IFS= read -r rel; do
        mkdir -p "$DEST/npm/$name/$(dirname "$rel")"
        cp "$TMP/pkg-$name/$rel" "$DEST/npm/$name/$rel"
      done
done

echo "== verifying corpus against MANIFEST.json"
node "$DEST/build_manifest.js" --verify
