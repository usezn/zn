#!/usr/bin/env bash
# Lists the Actions caches of main that a newer cache of the same family has replaced.
#
# Input (stdin), tab separated, one cache per line: id, key, ref, size in bytes, created_at.
# Output (stdout), tab separated: id, key, size in bytes, for each superseded cache.
# Only refs/heads/main is considered, and nothing is ever deleted here.
#
# Two families only, because each of their caches is large and a new one is saved whenever the
# Cargo.lock file or the CodeQL base commit changes, while the old one is never restored again:
#   - Swatinem/rust-cache keys: v0-rust-<job>-<os>-<arch>-<environment hash>-<lock file hash>.
#     The family is the key without its last two parts. A cache whose lock file hash differs from
#     the newest cache of its family is superseded. Caches that share the newest lock file hash are
#     kept (a runner image change can legitimately leave two live ones).
#   - CodeQL overlay base databases: codeql-overlay-base-database-1-<hash>-<language>-<version>-<sha>-<run>-1.
#     The family is hash plus language; only the newest is kept.
set -euo pipefail

sort -t "$(printf '\t')" -k5,5r | awk -F '\t' '
  $3 != "refs/heads/main" { next }
  $2 ~ /^v0-rust-/ {
    fam = $2; sub(/-[^-]+-[^-]+$/, "", fam)
    lock = $2; sub(/^.*-/, "", lock)
    if (!(fam in newest)) { newest[fam] = lock; next }
    if (lock != newest[fam]) print $1 "\t" $2 "\t" $4
    next
  }
  $2 ~ /^codeql-overlay-base-database-1-[0-9a-f]+-[A-Za-z+-]+-[0-9.]+-[0-9a-f]{40}-[0-9]+-1$/ {
    fam = $2; sub(/^codeql-overlay-base-database-1-/, "", fam); sub(/-[0-9.]+-[0-9a-f]{40}-[0-9]+-1$/, "", fam)
    if (!(fam in seen)) { seen[fam] = 1; next }
    print $1 "\t" $2 "\t" $4
  }
'
