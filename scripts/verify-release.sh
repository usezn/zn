#!/usr/bin/env bash
# Verifies a PUBLISHED zn-gate release: checksums, GitHub artifact attestations,
# the Sigstore signature of SHA256SUMS, npm provenance and PyPI attestations.
# Every step is described in docs/verify-release.md; this script only runs the
# commands that document names. Download it from the release tag and read it
# before you run it. Do not pipe it to a shell.
#
# Exit status: 0 only if every step passed. A step that cannot run (a tool is
# missing) counts as NOT verified and makes the exit status non-zero.
set -euo pipefail

REPO="usezn/zn"
ISSUER="https://token.actions.githubusercontent.com"

usage() {
  cat <<'EOF'
Usage: verify-release.sh [--print] [--keep DIR] VERSION
       verify-release.sh -h

Verifies the published zn-gate release VERSION (for example 1.14.1).

  --print     print the commands that would run and run nothing
  --keep DIR  download the release files into DIR (new or empty) and keep them;
              without it they go to a temporary directory that is removed on exit
  -h          show this help

Tools used: gh, npm, sha256sum (or shasum), cosign or sigstore-python, and
pypi-attestations. A tool that is missing means that step is not verified.
Read docs/verify-release.md ("What this does and does not prove") first.
EOF
}

die2() {
  echo "verify-release: $*" >&2
  exit 2
}

PRINT=0
KEEP=""
VERSION=""
HAVE_VERSION=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --print) PRINT=1 ;;
    --keep)
      [ $# -ge 2 ] || die2 "--keep needs a directory"
      KEEP="$2"
      case "$KEEP" in
        '' | -*) die2 "--keep needs a directory name that does not start with '-'" ;;
      esac
      shift
      ;;
    -*) die2 "unknown option: $1 (try -h)" ;;
    *)
      [ "$HAVE_VERSION" -eq 0 ] || die2 "only one version can be given"
      VERSION="$1"
      HAVE_VERSION=1
      ;;
  esac
  shift
done

# --- Version: validated before it reaches any command or URL ---------------
[ "$HAVE_VERSION" -eq 1 ] || die2 "a version is required, for example: verify-release.sh 1.14.1"
VERSION_RE='^([0-9]+)\.([0-9]+)\.([0-9]+)(-([0-9A-Za-z.]+))?$'
if ! [[ "$VERSION" =~ $VERSION_RE ]]; then
  die2 "not a valid version (expected X.Y.Z or X.Y.Z-pre.N): refusing to run anything"
fi
V_MAJ="${BASH_REMATCH[1]}"
V_MIN="${BASH_REMATCH[2]}"
V_PAT="${BASH_REMATCH[3]}"
V_PRE="${BASH_REMATCH[5]:-}"
if [ "${#V_MAJ}" -gt 6 ] || [ "${#V_MIN}" -gt 6 ] || [ "${#V_PAT}" -gt 6 ]; then
  die2 "version numbers are too large"
fi
V_MAJ=$((10#$V_MAJ))
V_MIN=$((10#$V_MIN))
V_PAT=$((10#$V_PAT))
# Comparable number: major, minor and patch, each below 1000000.
V_NUM=$((V_MAJ * 1000000000000 + V_MIN * 1000000 + V_PAT))
NUM_1_5_0=$((1 * 1000000000000 + 5 * 1000000))
NUM_1_12_0=$((1 * 1000000000000 + 12 * 1000000))

# Releases up to 1.5.0-beta.1 were published by hand and have nothing to verify.
if [ "$V_NUM" -lt "$NUM_1_5_0" ]; then
  die2 "$VERSION has no signatures, attestations or provenance (the first signed release is 1.5.0-beta.2); compare it with the tagged source instead"
fi
if [ "$V_NUM" -eq "$NUM_1_5_0" ]; then
  case "$V_PRE" in
    '' | rc.* | beta.[2-9] | beta.[1-9][0-9]*) ;;
    *) die2 "$VERSION has no signatures, attestations or provenance (the first signed release is 1.5.0-beta.2); compare it with the tagged source instead" ;;
  esac
fi

# PyPI spells the version in PEP 440 form: 1.5.0-beta.2 -> 1.5.0b2 (alpha -> a, rc -> rc).
BASE="${V_MAJ}.${V_MIN}.${V_PAT}"
PY_VERSION="$BASE"
if [ -n "$V_PRE" ]; then
  PRE_RE='^(alpha|beta|rc)\.([0-9]+)$'
  if ! [[ "$V_PRE" =~ $PRE_RE ]]; then
    die2 "unsupported pre-release '$V_PRE' (releases are X.Y.Z or X.Y.Z-(alpha|beta|rc).N)"
  fi
  case "${BASH_REMATCH[1]}" in
    alpha) PY_VERSION="${BASE}a${BASH_REMATCH[2]}" ;;
    beta) PY_VERSION="${BASE}b${BASH_REMATCH[2]}" ;;
    rc) PY_VERSION="${BASE}rc${BASH_REMATCH[2]}" ;;
  esac
fi
# From the version written to the tag, not the numbers parsed above (1.05.0 is not 1.5.0).
if [ "${V_MAJ}.${V_MIN}.${V_PAT}${V_PRE:+-$V_PRE}" != "$VERSION" ]; then
  die2 "version has leading zeros: $VERSION"
fi

TAG="v${VERSION}"
if [ "$V_NUM" -ge "$NUM_1_12_0" ]; then
  SIGNER="build-release.yml"
else
  SIGNER="release.yml"
fi
SIGNER_WORKFLOW="${REPO}/.github/workflows/${SIGNER}"
IDENTITY="https://github.com/${SIGNER_WORKFLOW}@refs/tags/${TAG}"
TGZ="zn-gate-${VERSION}.tgz"
SDIST="zn_gate-${PY_VERSION}.tar.gz"
WHEEL="zn_gate-${PY_VERSION}-py3-none-any.whl"
SBOM_NPM="zn-gate-${VERSION}.cdx.json"
SBOM_PY="zn_gate-${PY_VERSION}.cdx.json"

# --- Working directory ------------------------------------------------------
WORK=""
# shellcheck disable=SC2329  # called from the EXIT trap
cleanup() {
  if [ -n "$WORK" ] && [ -z "$KEEP" ]; then
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$PRINT" -eq 1 ]; then
  WORK="<download-dir>"
elif [ -n "$KEEP" ]; then
  if [ -e "$KEEP" ] && { [ ! -d "$KEEP" ] || [ -n "$(ls -A -- "$KEEP")" ]; }; then
    die2 "--keep directory exists and is not empty: $KEEP"
  fi
  mkdir -p -- "$KEEP"
  WORK="$(cd "$KEEP" && pwd)"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/zn-verify-release.XXXXXX")"
fi

# --- Output helpers ---------------------------------------------------------
FAILED=0
UNCHECKED=0
PASSED=0

show() {
  printf '  $'
  printf ' %q' "$@"
  printf '\n'
}

pass() {
  echo "[$1] $2 ... PASS"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "[$1] $2 ... FAIL ($3)"
  FAILED=$((FAILED + 1))
}

cannot() {
  echo "[$1] $2 ... CANNOT CHECK ($3): NOT VERIFIED"
  UNCHECKED=$((UNCHECKED + 1))
}

have() { command -v "$1" > /dev/null 2>&1; }

OUT="$(mktemp "${TMPDIR:-/tmp}/zn-verify-out.XXXXXX" 2> /dev/null || true)"
if [ -z "$OUT" ]; then
  [ "$PRINT" -eq 1 ] || die2 "cannot create a temporary file"
fi
trap 'rm -f -- "$OUT"; cleanup' EXIT

# Runs a command with its output kept; on failure prints its last lines.
# Usage: attempt LABEL cmd args...   (returns the command's status)
attempt() {
  local rc=0
  "${@:2}" > "$OUT" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    tail -n 12 "$OUT" | sed 's/^/      | /'
  fi
  return "$rc"
}

echo "zn-gate ${VERSION} (PyPI ${PY_VERSION}), tag ${TAG}, signer workflow ${SIGNER}"

# --- Download ---------------------------------------------------------------
DOWNLOADED=0
DL_REASON=""
if [ "$PRINT" -eq 1 ]; then
  echo "[download] GitHub Release files"
  show gh release download "$TAG" --repo "$REPO" --dir "$WORK"
elif ! have gh; then
  DL_REASON="gh missing"
elif attempt download gh release download "$TAG" --repo "$REPO" --dir "$WORK"; then
  DOWNLOADED=1
else
  DL_REASON="could not download the files of release ${TAG} from ${REPO}"
fi

# --- 1. Checksums -----------------------------------------------------------
S1="1/5"
N1="Checksums (SHA256SUMS)"
if [ "$PRINT" -eq 1 ]; then
  echo "[$S1] $N1"
  show sha256sum --strict -c SHA256SUMS
  echo "  (macOS: shasum -a 256 -c SHA256SUMS; SHA256SUMS must list each of: $TGZ $SDIST $WHEEL)"
elif [ "$DOWNLOADED" -ne 1 ]; then
  if [ "$DL_REASON" = "gh missing" ]; then cannot "$S1" "$N1" "gh missing"; else fail "$S1" "$N1" "$DL_REASON"; fi
elif ! have sha256sum && ! have shasum; then
  cannot "$S1" "$N1" "sha256sum or shasum missing"
else
  listed_ok=1
  for f in "$TGZ" "$SDIST" "$WHEEL"; do
    if [ ! -f "$WORK/$f" ]; then
      echo "      | missing release file: $f"
      listed_ok=0
    elif ! awk -v f="$f" '$2 == f || $2 == "*" f { n++ } END { exit (n == 1 ? 0 : 1) }' "$WORK/SHA256SUMS" 2> /dev/null; then
      echo "      | SHA256SUMS has no single entry for: $f"
      listed_ok=0
    fi
  done
  if [ "$listed_ok" -ne 1 ]; then
    fail "$S1" "$N1" "release files or SHA256SUMS entries are missing"
  elif have sha256sum; then
    if (cd "$WORK" && attempt sums sha256sum --strict -c SHA256SUMS); then pass "$S1" "$N1"; else fail "$S1" "$N1" "checksums do not match"; fi
  else
    if (cd "$WORK" && attempt sums shasum -a 256 -c SHA256SUMS); then pass "$S1" "$N1"; else fail "$S1" "$N1" "checksums do not match"; fi
  fi
fi

# --- 2. GitHub artifact attestations ---------------------------------------
S2="2/5"
N2="GitHub artifact attestations"
if [ "$PRINT" -eq 1 ]; then
  echo "[$S2] $N2 (each of: $TGZ $SDIST $WHEEL SHA256SUMS, and the SBOMs if the release has them)"
  show gh attestation verify "$WORK/$TGZ" --repo "$REPO" --signer-workflow "$SIGNER_WORKFLOW" --source-ref "refs/tags/${TAG}"
elif [ "$DOWNLOADED" -ne 1 ]; then
  if [ "$DL_REASON" = "gh missing" ]; then cannot "$S2" "$N2" "gh missing"; else fail "$S2" "$N2" "$DL_REASON"; fi
else
  att_files=("$TGZ" "$SDIST" "$WHEEL" "SHA256SUMS")
  for f in "$SBOM_NPM" "$SBOM_PY"; do
    [ -f "$WORK/$f" ] && att_files+=("$f")
  done
  att_bad=""
  for f in "${att_files[@]}"; do
    if [ ! -f "$WORK/$f" ]; then
      echo "      | missing release file: $f"
      att_bad="$att_bad $f"
    elif ! attempt att gh attestation verify "$WORK/$f" --repo "$REPO" --signer-workflow "$SIGNER_WORKFLOW" --source-ref "refs/tags/${TAG}"; then
      att_bad="$att_bad $f"
    fi
  done
  if [ -z "$att_bad" ]; then pass "$S2" "$N2 (${#att_files[@]} files)"; else fail "$S2" "$N2" "not verified:${att_bad}"; fi
fi

# --- 3. Sigstore signature of SHA256SUMS -----------------------------------
S3="3/5"
N3="Sigstore signature of SHA256SUMS"
if [ "$PRINT" -eq 1 ]; then
  echo "[$S3] $N3"
  show cosign verify-blob "$WORK/SHA256SUMS" --bundle "$WORK/SHA256SUMS.sigstore.json" --new-bundle-format \
    --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER"
  echo "  (without cosign: python3 -m sigstore verify identity, as in docs/verify-release.md step 3)"
elif [ "$DOWNLOADED" -ne 1 ]; then
  if [ "$DL_REASON" = "gh missing" ]; then cannot "$S3" "$N3" "gh missing"; else fail "$S3" "$N3" "$DL_REASON"; fi
elif [ ! -f "$WORK/SHA256SUMS" ] || [ ! -f "$WORK/SHA256SUMS.sigstore.json" ]; then
  fail "$S3" "$N3" "SHA256SUMS or SHA256SUMS.sigstore.json is missing from the release"
elif have cosign; then
  if attempt sig cosign verify-blob "$WORK/SHA256SUMS" --bundle "$WORK/SHA256SUMS.sigstore.json" --new-bundle-format \
    --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER"; then
    pass "$S3" "$N3 (cosign)"
  else
    fail "$S3" "$N3" "cosign did not verify the bundle"
  fi
elif have python3 && python3 -c 'import sigstore' > /dev/null 2>&1; then
  if attempt sig python3 -m sigstore verify identity --bundle "$WORK/SHA256SUMS.sigstore.json" \
    --cert-identity "$IDENTITY" --cert-oidc-issuer "$ISSUER" "$WORK/SHA256SUMS"; then
    pass "$S3" "$N3 (sigstore-python)"
  else
    fail "$S3" "$N3" "sigstore-python did not verify the bundle"
  fi
else
  cannot "$S3" "$N3" "cosign and sigstore-python missing"
fi

# --- 4. npm provenance ------------------------------------------------------
S4="4/5"
N4="npm provenance"
if [ "$PRINT" -eq 1 ]; then
  echo "[$S4] $N4 (in a new empty project directory)"
  show npm install --ignore-scripts --no-audit --no-fund "zn-gate@${VERSION}"
  show npm audit signatures
  show npm view "zn-gate@${VERSION}" dist.attestations
elif ! have npm; then
  cannot "$S4" "$N4" "npm missing"
else
  NPM_DIR="$WORK/npm-check"
  mkdir -p -- "$NPM_DIR"
  printf '{"name":"zn-gate-verify","version":"0.0.0","private":true}\n' > "$NPM_DIR/package.json"
  npm_reason=""
  if ! (cd "$NPM_DIR" && attempt npm npm install --ignore-scripts --no-audit --no-fund "zn-gate@${VERSION}"); then
    npm_reason="npm install of zn-gate@${VERSION} failed"
  elif ! grep -Fq "\"version\": \"${VERSION}\"" "$NPM_DIR/node_modules/zn-gate/package.json" 2> /dev/null; then
    npm_reason="the installed package is not version ${VERSION}"
  elif ! (cd "$NPM_DIR" && attempt npm npm audit signatures); then
    npm_reason="npm audit signatures failed"
  elif ! (cd "$NPM_DIR" && npm view "zn-gate@${VERSION}" dist.attestations > "$OUT" 2>&1) || ! grep -q '[^[:space:]]' "$OUT"; then
    npm_reason="npm shows no attestations for zn-gate@${VERSION}"
  fi
  if [ -z "$npm_reason" ]; then pass "$S4" "$N4"; else fail "$S4" "$N4" "$npm_reason"; fi
fi

# --- 5. PyPI attestations ---------------------------------------------------
S5="5/5"
N5="PyPI attestations"
PYPI_CMD=()
if have pypi-attestations; then
  PYPI_CMD=(pypi-attestations)
elif have python3 && python3 -m pypi_attestations --help > /dev/null 2>&1; then
  PYPI_CMD=(python3 -m pypi_attestations)
fi
if [ "$PRINT" -eq 1 ]; then
  echo "[$S5] $N5 (for each of the wheel and the source distribution)"
  show pypi-attestations verify pypi --repository "https://github.com/${REPO}" "pypi:${WHEEL}"
  show pypi-attestations verify pypi --repository "https://github.com/${REPO}" "pypi:${SDIST}"
elif [ "${#PYPI_CMD[@]}" -eq 0 ]; then
  cannot "$S5" "$N5" "pypi-attestations missing"
else
  py_bad=""
  for f in "$WHEEL" "$SDIST"; do
    if ! attempt pypi "${PYPI_CMD[@]}" verify pypi --repository "https://github.com/${REPO}" "pypi:${f}"; then
      py_bad="$py_bad $f"
    fi
  done
  if [ -z "$py_bad" ]; then pass "$S5" "$N5 (2 files)"; else fail "$S5" "$N5" "not verified:${py_bad}"; fi
fi

# --- Result -----------------------------------------------------------------
echo
if [ "$PRINT" -eq 1 ]; then
  echo "Nothing was run (--print). Read the commands, then run without --print."
  exit 0
fi
if [ "$FAILED" -eq 0 ] && [ "$UNCHECKED" -eq 0 ]; then
  echo "VERIFIED: zn-gate ${VERSION}: all 5 checks passed. This shows the files were produced by ${SIGNER} of ${REPO} at ${TAG} and were not changed since. It does not show the source or the build pipeline was free of mistakes or malicious changes: see \"What this does and does not prove\" in docs/verify-release.md."
  exit 0
fi
echo "NOT VERIFIED: zn-gate ${VERSION}: ${PASSED} passed, ${FAILED} failed, ${UNCHECKED} could not be checked. Do not install these files on the strength of this run; see \"If something does not match\" and \"What this does and does not prove\" in docs/verify-release.md."
if [ -n "$KEEP" ]; then
  echo "Downloaded files kept in: $WORK"
fi
exit 1
