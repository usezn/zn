#!/usr/bin/env bash
# Checks that the release build is independent of the build directory: builds the committed tree twice,
# in two different directories with their own cargo home and target directory, and compares the SHA-256
# of the two binaries. Exits 1 when they differ.
#
# Usage: scripts/check-repro-build.sh [work-dir]
# Needs network access for the second cargo home (crates are downloaded again) and a few GB of disk.
# Uncommitted changes are not built: the script archives HEAD.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="${1:-$(mktemp -d "${TMPDIR:-/tmp}/zn-repro.XXXXXX")}"
mkdir -p "$work"
work="$(cd "$work" && pwd -P)"

# The toolchain stays where it is; only the cargo home (registry sources) and the checkout move.
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"

build_in() {
  local name="$1" dir="$2"
  mkdir -p "$dir/src-tree" "$dir/cargo-home" "$dir/target"
  git -C "$repo" archive HEAD | tar -x -C "$dir/src-tree"
  (
    cd "$dir/src-tree"
    CARGO_HOME="$dir/cargo-home" CARGO_TARGET_DIR="$dir/target" bash scripts/repro-build.sh >&2
  )
  cp "$dir/target/release/zn" "$work/zn-$name"
  sha256sum "$work/zn-$name" | cut -d' ' -f1
}

a="$(build_in one "$work/alpha")"
rm -rf "$work/alpha"
b="$(build_in two "$work/beta/deeper/place")"
rm -rf "$work/beta"

echo "build one: $a"
echo "build two: $b"
if [ "$a" = "$b" ]; then
  echo "identical"
else
  echo "DIFFERENT" >&2
  cmp -l "$work/zn-one" "$work/zn-two" | wc -l | sed 's/^/differing bytes: /' >&2
  exit 1
fi
