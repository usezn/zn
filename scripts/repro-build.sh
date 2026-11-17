#!/usr/bin/env bash
# Builds the release binary so that it does not depend on where it was built.
#
# Cargo embeds absolute paths in a release binary: the build scripts' output directories (for example
# cranelift-codegen and candle-onnx), the crate sources in the cargo registry, and the repository itself.
# Two clean builds in different directories therefore differ even when the sources are identical. This
# script maps those directories to fixed names with --remap-path-prefix, so the same commit built with
# the same toolchain gives the same bytes anywhere.
#
# Usage: scripts/repro-build.sh [extra cargo build arguments]
# The binary ends up in $CARGO_TARGET_DIR/release/zn (target/release/zn by default).
# Cargo's own trim-paths profile option is still unstable, which is why this uses rustc flags.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
target_dir="${CARGO_TARGET_DIR:-$root/target}"

# Existing flags are kept; the mappings come last so they win when directories overlap (the last
# matching --remap-path-prefix applies): the target directory may sit inside the repository.
flags="${RUSTFLAGS:-}"
flags="$flags --remap-path-prefix=$root=/build/zn"
flags="$flags --remap-path-prefix=$target_dir=/build/target"
flags="$flags --remap-path-prefix=$cargo_home=/build/cargo"
flags="$flags --remap-path-prefix=$rustup_home=/build/rustup"
export RUSTFLAGS="$flags"

cd "$root"
exec cargo build --release --locked "$@"
