#!/bin/bash
# Official ZCode Desktop 3.16.3 .deb on Debian 12, e2e of zn-gate adapter (fictitious values only)
set -uo pipefail
: "${ZN_OUT:?}"
mkdir -p "$ZN_OUT/_status" "$ZN_OUT/cases"
ZN_RC_FILE="${ZN_RC_FILE:-$ZN_OUT/_status/rc}"
trap 'rc=$?; echo "$rc" > "$ZN_RC_FILE"; echo "[entry] exit rc=$rc"' EXIT
exec > >(tee -a "$ZN_OUT/lin.log") 2>&1
KIT="$(cd "$(dirname "$0")" && pwd)"
echo "[lin] start $(date -u +%FT%TZ) $(uname -a)"
mkdir -p /work; chmod 777 /work; cd /work
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq xz-utils curl ca-certificates python3 xvfb xdotool imagemagick x11-utils >/dev/null 2>&1; echo "[lin] base apt rc=$?"
URL=https://cdn-zcode.z.ai/zcode/electron/releases/3.16.3/linux-x64/ZCode-3.16.3-linux-x64.deb
curl -fsSL "$URL" -o /work/ZCode.deb || { echo "[lin] deb download failed"; exit 11; }
{ echo "url=$URL"; sha256sum /work/ZCode.deb; dpkg-deb -f /work/ZCode.deb Version Package; } | tee "$ZN_OUT/deb_info.txt"
apt-get install -y -qq libasound2 libgbm1 libxkbcommon0 libdrm2 libcups2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libpango-1.0-0 libcairo2 libx11-xcb1 libxcb-dri3-0 > "$ZN_OUT/extra_libs.log" 2>&1; echo "[lin] extra libs rc=$?"
apt-get install -y -qq /work/ZCode.deb > "$ZN_OUT/deb_install.log" 2>&1; echo "[lin] deb install rc=$?"
ls -la /opt/ZCode/resources/glm | head; /opt/ZCode/zcode --version 2>&1 | head -3 || true
NODE_V=22.22.0
curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o /work/shasums.txt
NODE_F=$(grep 'linux-x64.tar.xz' /work/shasums.txt | awk '{print $2}')
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$NODE_F" -o /work/node.tar.xz
mkdir -p /work/node && tar -xJf /work/node.tar.xz -C /work/node --strip-components=1
export PATH=/work/node/bin:$PATH
node -v | tee "$ZN_OUT/node_version.txt"
# official bundled runtime (what the app spawns: ELECTRON_RUN_AS_NODE + resources/glm/zcode.cjs app-server --stdio)
cat > /work/zcrt <<'W'
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE=/opt/ZCode/resources/config/provider/zcode-builtin.json exec /opt/ZCode/zcode "$@"
W
chmod +x /work/zcrt
ln -s ../config/provider /opt/ZCode/resources/glm/provider && echo "[lin] shim symlink glm/provider -> ../config/provider"
export ZC_NODE=/work/zcrt ZC_CLI=/opt/ZCode/resources/glm/zcode.cjs
/work/zcrt "$ZC_CLI" --version 2>&1 | tee "$ZN_OUT/runtime_version.txt"
sha256sum "$ZC_CLI" | tee "$ZN_OUT/zcode_cjs_sha256.txt"
cp /opt/ZCode/resources/glm/.node-bundle-meta.json "$ZN_OUT/" 2>/dev/null
npm i -g "$KIT"/zn-gate-*.tgz >"$ZN_OUT/npm_install_zn.log" 2>&1; echo "[lin] npm install zn rc=$?"
zn --version | tee "$ZN_OUT/zn_version_global.txt"
cp -r "$KIT/market" /work/market
export KIT WORK=/work OUT="$ZN_OUT/plugin_e2e"
mkdir -p "$OUT"
timeout 2400 python3 "$KIT/e2ep.py" > "$ZN_OUT/e2e_plugin.log" 2>&1; echo "[lin] e2ep rc=$?"
echo "[lin] done $(date -u +%FT%TZ)"
echo ok > "$ZN_OUT/summary.txt"
