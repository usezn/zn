#!/usr/bin/env bash
# Installs the built zn-gate tarball in a clean node:22-slim container and runs the MCP smoke test there.
# The server step runs with no network at all, which also proves ZN_LOCAL_ONLY=true needs none.
# Usage: .github/scripts/mcp-smoke-docker.sh path/to/zn-gate-X.Y.Z.tgz
set -euo pipefail
tgz="${1:?usage: mcp-smoke-docker.sh <zn-gate tarball>}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$tgz" "$work/zn-gate.tgz"
cp "$here/mcp-smoke.mjs" "$work/mcp-smoke.mjs"
chmod -R a+rwX "$work"
image=node:22-slim
# Containers run as the caller, so nothing they write is root-owned and the cleanup below works.
user=(--user "$(id -u):$(id -g)" -e HOME=/w/home)

echo "== install (network on, scripts disabled)"
docker run --rm "${user[@]}" -v "$work:/w" -w /w "$image" sh -c 'npm install -g --ignore-scripts --prefix /w/prefix /w/zn-gate.tgz >/dev/null && ls /w/prefix/bin'

echo "== smoke (no network)"
docker run --rm "${user[@]}" --network none -v "$work:/w:ro" -w /tmp -e PATH=/w/prefix/bin:/usr/local/bin:/usr/bin:/bin "$image" \
  timeout 60 node /w/mcp-smoke.mjs zn-gate mcp
