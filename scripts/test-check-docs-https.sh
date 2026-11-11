#!/usr/bin/env bash
# Tests scripts/check-docs-https.sh on temporary trees. Usage: bash scripts/test-check-docs-https.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/check-docs-https.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/docs-https-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail=0

# page <tree>: writes the Markdown read from stdin to <tree>/docs/page.md
page() {
  mkdir -p "$work/$1/docs"
  cat > "$work/$1/docs/page.md"
}

# expect <tree> <exit code>: the check must exit with that code on the tree
expect() {
  local got=0
  bash "$script" "$work/$1" > /dev/null 2>&1 || got=$?
  if [ "$got" != "$2" ]; then
    echo "FAIL $1: exit $got, want $2"
    fail=1
  fi
}

page ok <<'EOF'
Use [the guide](https://example.com/guide), http://localhost:8080 or http://127.0.0.1:9090/api.
Inline `curl http://example.org` is not checked.

```sh
curl http://example.org
```

~~~
http://example.org
~~~
EOF
expect ok 0

page plain <<'EOF'
See http://example.org for details.
EOF
expect plain 1

page link <<'EOF'
[the spec](http://example.org/spec)
EOF
expect link 1

page autolink <<'EOF'
<http://example.org>
EOF
expect autolink 1

page after-fence <<'EOF'
```
code
```
http://example.org
EOF
expect after-fence 1

mkdir -p "$work/readme"
echo 'Visit http://example.org' > "$work/readme/README.md"
expect readme 1

[ "$fail" = 0 ] && echo "docs https link check: tests pass"
exit "$fail"
