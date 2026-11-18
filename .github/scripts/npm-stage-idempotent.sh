#!/usr/bin/env bash
# Stages the verified npm tarball (`npm stage publish`, trusted publishing) so that running it again is safe.
#
# Why: a first attempt can leave an entry in the transparency log (Rekor) and then fail; the next
# `npm stage publish` of the same tarball answers with error 409 ("an equivalent entry already exists
# in the transparency log"). That is not a reason to stop the release by hand.
#
# What it decides, in this order:
#   1. Before staging: the version is already public on the registry.
#        same integrity as the tarball built here -> nothing to do, exit 0 (result=already-live)
#        different integrity                      -> fail (someone else's file is live)
#   2. Stage. Success -> exit 0 (result=staged).
#   3. Stage failed with a 409 / "equivalent entry" message: look at the registry again.
#        public with the same integrity -> done, exit 0 (result=already-live)
#        public with another integrity  -> fail
#        not public                     -> wait and stage again (up to STAGE_ATTEMPTS tries in all), then fail
#   4. Any other failure of the stage command fails at once.
# "Public" is read with `npm view <pkg>@<version> dist.integrity`; the provenance attestation of a public
# version (`dist.attestations.url`) is reported but is not required for the decision.
#
# Environment: NPM_VERSION, DIST_TAG, TARBALL (required); PKG (zn-gate), NPM_BIN (npm), STAGE_ATTEMPTS (3),
# STAGE_RETRY_SECONDS (20), STAGE_OUTPUT (file that receives the output of every attempt),
# GITHUB_OUTPUT (when set, receives result=staged|already-live).
set -euo pipefail

pkg="${PKG:-zn-gate}"
version="${NPM_VERSION:?NPM_VERSION is required}"
tag="${DIST_TAG:?DIST_TAG is required}"
tarball="${TARBALL:?TARBALL is required}"
npm_bin="${NPM_BIN:-npm}"
attempts="${STAGE_ATTEMPTS:-3}"
pause="${STAGE_RETRY_SECONDS:-20}"
out="${STAGE_OUTPUT:-/dev/null}"

[ -f "$tarball" ] || { echo "::error::$tarball is missing"; exit 1; }
want="sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 | tr -d '\n')"

result() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "result=$1" >> "$GITHUB_OUTPUT"; fi
}

# 0 = public with the same integrity, 1 = not public, exits 1 when public with another integrity.
check_live() {
  local got att
  got="$("$npm_bin" view "${pkg}@${version}" dist.integrity --prefer-online 2>/dev/null || true)"
  [ -n "$got" ] || return 1
  if [ "$got" != "$want" ]; then
    echo "::error::${pkg} ${version} is already on npm with integrity '${got}', but the verified tarball has '${want}'"
    exit 1
  fi
  att="$("$npm_bin" view "${pkg}@${version}" dist.attestations.url --prefer-online 2>/dev/null || true)"
  if [ -n "$att" ]; then
    echo "${pkg} ${version} is on npm with this tarball and a provenance attestation ($att)."
  else
    echo "::warning::${pkg} ${version} is on npm with this tarball, but the registry shows no provenance attestation for it."
  fi
  return 0
}

if check_live; then
  echo "::notice title=Already on npm::${pkg} ${version} is already public with this tarball, so it is not staged again."
  result already-live
  exit 0
fi

attempt=1
while :; do
  log="$(mktemp)"
  set +e
  "$npm_bin" stage publish "./$tarball" --tag "$tag" --access public --provenance --ignore-scripts 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  set -e
  cat "$log" >> "$out"
  if [ "$rc" -eq 0 ]; then
    rm -f "$log"
    result staged
    exit 0
  fi
  if grep -qiE 'E?409|equivalent entry|already exists in the transparency log' "$log"; then
    rm -f "$log"
    echo "::warning::npm stage publish answered 409 (an equivalent transparency log entry exists), attempt ${attempt} of ${attempts}."
    if check_live; then
      echo "::notice title=Already on npm::${pkg} ${version} is public with this tarball, so the 409 is treated as done."
      result already-live
      exit 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::error::npm stage publish kept answering 409 and ${pkg} ${version} is not public. Re-run the failed jobs of this run, or check npm stage list ${pkg}."
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep "$pause"
    continue
  fi
  rm -f "$log"
  echo "::error::npm stage publish failed (exit ${rc}) and the error is not a 409."
  exit "$rc"
done
