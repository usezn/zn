cp -r "$KIT/market" /work/market
# ---- GUI drive under Xvfb with the fake provider (fictitious values only); ZCode plugin installed FROM the GUI
export HOME=/work/guihome; rm -rf $HOME; mkdir -p $HOME/.zcode/cli $HOME/.zcode/v2 /work/proj /work/gui
export OUT="$ZN_OUT/guirun"; mkdir -p "$OUT"
cat > /work/seed.py <<'PY'
import json,os
H='/work/guihome'
prov={'schemaVersion':1,'config':{'providerConfigRules':{'providerRules':[{'providerId':'fakeprov','providerName':'Fake','config':{'group':'standard-personal','access':{'type':'api-key','apiKey':'FAKE_KEY_123'},'api':{'type':'openai-chat-completions','baseUrl':'http://127.0.0.1:18080/v1'},'personalModelIds':['fake-model']}}]},'modelConfigRules':{'providerModelRules':[],'manualProviderModelRules':[]},'defaultModelSelection':{'providerId':'fakeprov','modelId':'fake-model'}}}
json.dump(prov,open(H+'/.zcode/v2/provider_config.json','w'),indent=1)
open('/work/proj/a.txt','w').write('hello world\n')
open('/work/proj/.env','w').write('API_KEY=FAKE_sk_live_0123456789abcdef0123456789abcdef\n')
os.makedirs(H+'/.aws',exist_ok=True)
open(H+'/.aws/credentials','w').write('[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n')
json.dump({'steps':[{'tool':'read','values':{'file_path':'/work/proj/.env'}},{'tool':'bash','values':{'command':'cat ~/.aws/credentials'}},{'tool':'bash','values':{'command':'ls'}},{'tool':'read','values':{'file_path':'/work/proj/a.txt'}}],'final':'done'},open('/work/scenario.json','w'))
json.dump({'hooks':{'enabled':False}},open(H+'/.zcode/cli/config.json','w'))
PY
python3 /work/seed.py
(python3 "$KIT/fake_provider.py" --port 18080 --scenario /work/scenario.json --log "$OUT/provider.jsonl" > "$OUT/provider.out" 2>&1 &)
export DISPLAY=:99 ELECTRON_ENABLE_LOGGING=1
Xvfb :99 -screen 0 1440x900x24 >/work/gui/xvfb.log 2>&1 &
sleep 3
(cd /work/proj; /opt/ZCode/zcode --no-sandbox --disable-gpu --user-data-dir=/work/gui/ud > "$OUT/app.log" 2>&1 &)
sleep 25
n=0
shot() { n=$((n+1)); import -window root "$OUT/s$(printf %02d $n)_$1.png" 2>/dev/null; }
shot start
[ -f "$KIT/actions.sh" ] && source "$KIT/actions.sh"
cp -r $HOME/.zcode "$OUT/zcode_home_after" 2>/dev/null; rm -f "$OUT"/zcode_home_after/cli/db/*.sqlite* "$OUT"/zcode_home_after/v2/certs/*.key
pkill -f /opt/ZCode; pkill Xvfb; pkill -f fake_provider
echo ok > "$ZN_OUT/summary.txt"
