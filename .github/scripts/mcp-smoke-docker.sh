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
# Pinned by digest for reproducible runs. To update: read the Docker-Content-Digest header of a HEAD request to
# https://registry-1.docker.io/v2/library/node/manifests/22-slim (with a pull token), replace the digest below, and re-run the smoke.
image=node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# Protocol versions sent in initialize: every version the server supports.
protocols=(2024-11-05 2025-03-26 2025-06-18 2025-11-25)
# Containers run as the caller, so nothing they write is root-owned and the cleanup below works.
user=(--user "$(id -u):$(id -g)" -e HOME=/w/home)

echo "== install (network on, scripts disabled)"
docker run --rm "${user[@]}" -v "$work:/w" -w /w "$image" sh -c 'npm install -g --ignore-scripts --prefix /w/prefix /w/zn-gate.tgz >/dev/null && ls /w/prefix/bin'

for protocol in "${protocols[@]}"; do
  echo "== smoke (no network, protocolVersion $protocol)"
  docker run --rm "${user[@]}" --network none -v "$work:/w:ro" -w /tmp -e PATH=/w/prefix/bin:/usr/local/bin:/usr/bin:/bin \
    -e MCP_SMOKE_PROTOCOL="$protocol" "$image" \
    timeout 60 node /w/mcp-smoke.mjs zn-gate mcp
done
