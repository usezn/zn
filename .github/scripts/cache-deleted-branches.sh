#!/usr/bin/env bash
# Lists the Actions caches of branches that no longer exist.
#
# Input (stdin), tab separated, one cache per line: id, key, ref, size in bytes, created_at.
# Argument 1: a file with the names of the branches that exist, one per line.
# Output (stdout), tab separated: id, ref, size in bytes, for each cache of a deleted branch.
# Only refs/heads/<branch> refs are considered. Merge queue refs (refs/heads/gh-readonly-queue/...),
# pull request refs and tags are never listed here, and nothing is ever deleted here.
# main and next are never listed. If the branch list is empty (listing failed), nothing is listed.
set -euo pipefail

branches="${1:?usage: cache-deleted-branches.sh <branches file> < caches.tsv}"
if [ ! -s "$branches" ]; then
  echo "empty branch list; nothing listed" >&2
  cat > /dev/null
  exit 0
fi

awk -F '\t' -v branches="$branches" '
  BEGIN { while ((getline b < branches) > 0) if (b != "") live[b] = 1 }
  $3 !~ /^refs\/heads\// { next }
  $3 ~ /^refs\/heads\/gh-readonly-queue\// { next }
  {
    b = $3; sub(/^refs\/heads\//, "", b)
    if (b == "main" || b == "next") next
    if (!(b in live)) print $1 "\t" $3 "\t" $4
  }
'
