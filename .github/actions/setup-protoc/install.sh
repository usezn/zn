#!/usr/bin/env bash
# Download a pinned protoc release asset, verify its SHA-256 and put it on PATH. Fails closed.
set -euo pipefail

: "${PROTOC_VERSION:?}"
: "${RUNNER_TEMP:?}"
os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Linux-x86_64) asset_arch="linux-x86_64"; want="${SHA_LINUX_X86_64:?}" ;;
  Darwin-arm64) asset_arch="osx-aarch_64"; want="${SHA_OSX_AARCH_64:?}" ;;
  Darwin-x86_64) asset_arch="osx-x86_64"; want="${SHA_OSX_X86_64:?}" ;;
  *) echo "setup-protoc: unsupported platform ${os}-${arch}" >&2; exit 1 ;;
esac

asset="protoc-${PROTOC_VERSION}-${asset_arch}.zip"
dest="${RUNNER_TEMP}/protoc-${PROTOC_VERSION}"
mkdir -p "${dest}"
curl --fail --silent --show-error --location --retry 3 \
  --output "${RUNNER_TEMP}/${asset}" \
  "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/${asset}"

if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "${RUNNER_TEMP}/${asset}" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "${RUNNER_TEMP}/${asset}" | cut -d' ' -f1)"
fi
if [ "${got}" != "${want}" ]; then
  echo "setup-protoc: checksum mismatch for ${asset}: expected ${want}, got ${got}" >&2
  rm -f "${RUNNER_TEMP}/${asset}"
  exit 1
fi

unzip -q -o "${RUNNER_TEMP}/${asset}" -d "${dest}"
chmod +x "${dest}/bin/protoc"
rm -f "${RUNNER_TEMP}/${asset}"
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "${dest}/bin" >> "${GITHUB_PATH}"
fi
"${dest}/bin/protoc" --version
