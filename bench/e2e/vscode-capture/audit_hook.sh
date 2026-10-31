#!/usr/bin/env bash
# Audit hook for VS Code agent hooks: writes every payload it receives to a file and prints "{}" (no decision).
# It never blocks and never reads anything but stdin. Set ZN_CAPTURE_DIR (default ./captured).
set -u
dir=${ZN_CAPTURE_DIR:-./captured}
mkdir -p "$dir"
tag=${1:-event}
f="$dir/$(date -u +%Y%m%dT%H%M%S%N)-$tag.json"
cat > "$f"
printf '{}\n'
exit 0
