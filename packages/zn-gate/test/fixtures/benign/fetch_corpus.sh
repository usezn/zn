#!/usr/bin/env bash
# Regenerates the benign corpus for bench/leak_bench.js (WP5).
#
# Sources (pinned; npm tarballs are immutable on the registry):
#   - CPython standard library from a local install (PSF-2.0),
#     every *.py except test/ and __pycache__/
#   - npm: lodash@4.17.21 (MIT), async@3.2.6 (MIT)
#
# Usage:  PY_LIB=/usr/lib/python3.14 ./fetch_corpus.sh
# Needs:  bash, curl, tar, node >= 18, a local CPython Lib directory.
set -euo pipefail

DEST="$(cd "$(dirname "$0")" && pwd)"
PY_LIB="${PY_LIB:-/usr/lib/python3.14}"
NPM_PACKAGES=("lodash@4.17.21" "async@3.2.6")

if [ ! -d "$PY_LIB" ]; then
  echo "error: python stdlib not found at $PY_LIB (set PY_LIB=...)" >&2
  exit 1
fi

echo "== python stdlib from $PY_LIB"
rm -rf "$DEST/python-stdlib" "$DEST/npm" "$DEST/licenses"
mkdir -p "$DEST/licenses"
find "$PY_LIB" -name '*.py' -not -path '*__pycache__*' -not -path '*/test/*' -type f -print0 \
  | sort -z \
  | while IFS= read -r -d '' f; do
      rel="${f#"$PY_LIB"/}"
      mkdir -p "$DEST/python-stdlib/$(dirname "$rel")"
      cp "$f" "$DEST/python-stdlib/$rel"
    done

PY_SHORT="$(basename "$PY_LIB")"
for cand in "/usr/share/doc/$PY_SHORT/copyright" "/usr/share/doc/$PY_SHORT/LICENSE"; do
  if [ -f "$cand" ]; then
    cp "$cand" "$DEST/licenses/$PY_SHORT-copyright.txt"
    break
  fi
done

echo "== npm packages"
for spec in "${NPM_PACKAGES[@]}"; do
  name="${spec%@*}"
  ver="${spec##*@}"
  echo "   $name@$ver"
  mkdir -p "$DEST/npm/$name"
  curl -fsSL "https://registry.npmjs.org/$name/-/$name-$ver.tgz" | tar -xz -C "$DEST/npm/$name" --strip-components=1
done

echo "== manifest"
PY_LIB="$PY_LIB" PY_VER="$(python3 --version 2>/dev/null | awk '{print $2}' || echo unknown)" node "$DEST/build_manifest.js"

echo "== done: $(find "$DEST/python-stdlib" "$DEST/npm" -type f | wc -l) corpus files"
