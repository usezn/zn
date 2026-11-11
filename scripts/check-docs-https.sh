#!/usr/bin/env bash
# Fails when a Markdown page under docs/ or a README file has a bare http:// link. Links to localhost and
# 127.0.0.1 are allowed. Text inside fenced code blocks and inline code spans is not checked.
#
#   bash scripts/check-docs-https.sh [root]     default: the current directory (the repository root)
#
# Run by the quick checks of .github/workflows/quick-checks.yml; its test is scripts/test-check-docs-https.sh.
set -uo pipefail

root="${1:-.}"
cd "$root" || exit 1

# The pages to read: Markdown under docs/, and README files anywhere (node_modules and .git are skipped).
list_pages() {
  {
    find docs -type f -name '*.md' 2>/dev/null
    find . \( -name .git -o -name node_modules \) -prune -o -type f -name 'README*' -print 2>/dev/null | sed 's|^\./||'
  } | sort -u
}

# Prints one line per bare http:// link in the page and returns 1 when there is any.
scan_page() {
  awk -v file="$1" '
    BEGIN { fence = ""; bad = 0 }
    {
      line = $0
      if (fence != "") {
        t = line
        sub(/^[ ]+/, "", t)
        sub(/[ \t\r]+$/, "", t)
        ch = substr(fence, 1, 1)
        if (substr(t, 1, 1) == ch && t ~ /^[`~]+$/ && length(t) >= length(fence)) fence = ""
        next
      }
      if (line ~ /^[ ]*(```|~~~)/) {
        f = line
        sub(/^[ ]+/, "", f)
        match(f, /^[`~]+/)
        fence = substr(f, 1, RLENGTH)
        next
      }
      gsub(/`[^`]*`/, "", line)
      lower = tolower(line)
      pos = 1
      while ((i = index(substr(lower, pos), "http://")) > 0) {
        start = pos + i - 1
        rest = substr(lower, start + 7)
        if (rest !~ /^(localhost|127\.0\.0\.1)([:\/?#]|$)/) {
          printf "%s:%d: bare http:// link\n", file, NR > "/dev/stderr"
          bad = 1
        }
        pos = start + 7
      }
    }
    END { exit bad }
  ' "$1"
}

pages=0
status=0
while IFS= read -r page; do
  [ -n "$page" ] || continue
  pages=$((pages + 1))
  scan_page "$page" || status=1
done < <(list_pages)

if [ "$status" != 0 ]; then
  echo "" >&2
  echo "Use https:// for links in docs and READMEs (http://localhost and http://127.0.0.1 are allowed)." >&2
  exit 1
fi
echo "docs https links OK: $pages page(s) checked"
exit 0
