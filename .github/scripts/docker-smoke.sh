#!/usr/bin/env bash
# Smoke test for the gateway Docker image: it must run as a non-root user, print its version, score a
# prompt, answer the health check and exit cleanly when its input closes.
# Usage: .github/scripts/docker-smoke.sh <image>
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
name="zn-smoke-$$"
# A throw-away value: the management API is protected, so the health check needs a key.
api_key="smoke-test-key-0000000000000000"
fifo_dir="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$fifo_dir"
}
trap cleanup EXIT

echo "== configured user"
cfg_user="$(docker inspect --format '{{.Config.User}}' "$image")"
echo "Config.User=${cfg_user}"
case "$cfg_user" in
  ""|0|0:*|root|root:*) echo "FAIL: the image runs as root" >&2; exit 1 ;;
esac

echo "== --version"
docker run --rm "$image" --version | tee "$fifo_dir/version.txt"
grep -q '^zn ' "$fifo_dir/version.txt"

echo "== analyze exits 0"
docker run --rm -i "$image" analyze "hello, what is the weather today" >/dev/null

echo "== start: health check through a published port, and effective user"
mkfifo "$fifo_dir/stdin"
# Hold the container's stdin open; closing it later is the clean shutdown.
exec 3<>"$fifo_dir/stdin"
docker run --name "$name" -i -p 127.0.0.1:9090:9090 -e ZN_API_KEY="$api_key" "$image" start <"$fifo_dir/stdin" >"$fifo_dir/out.log" 2>&1 3>&- &
run_pid=$!

ok=0
for _ in $(seq 1 60); do
  if curl --fail --silent --max-time 2 --header "X-API-Key: ${api_key}" http://127.0.0.1:9090/api/v1/health >"$fifo_dir/health.txt"; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  echo "FAIL: the health check did not answer in 60 s" >&2
  cat "$fifo_dir/out.log" >&2 || true
  exit 1
fi
echo "health: $(cat "$fifo_dir/health.txt")"

pid="$(docker inspect --format '{{.State.Pid}}' "$name")"
uid="$(awk '/^Uid:/ {print $3}' "/proc/${pid}/status")"
gid="$(awk '/^Gid:/ {print $3}' "/proc/${pid}/status")"
echo "effective uid=${uid} gid=${gid}"
if [ "$uid" = 0 ] || [ "$gid" = 0 ]; then
  echo "FAIL: the gateway process runs as root" >&2
  exit 1
fi

echo "== clean exit on closed input"
exec 3>&-
# Closing the last writer ends the container's stdin, which is the gateway's clean shutdown.
code="$(timeout 60 docker wait "$name" || echo timeout)"
wait "$run_pid" || true
echo "exit code=${code}"
if [ "$code" != 0 ]; then
  echo "FAIL: the container did not exit cleanly" >&2
  cat "$fifo_dir/out.log" >&2 || true
  exit 1
fi
echo "SMOKE OK"
