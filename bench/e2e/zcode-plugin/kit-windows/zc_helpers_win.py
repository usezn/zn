#!/usr/bin/env python3
"""Windows helpers of the ZCode e2e kit (the app headless runtime, fake local provider, FICTITIOUS values only).
env: ZC_CLI (zcode.cjs), KIT, OUT, WORK, ZC_APPDIR. zn-gate is installed under WORK/npm."""
import os, sys, json, time, shutil, subprocess, hashlib, re, copy

KIT = os.environ.get('KIT', os.path.dirname(os.path.abspath(__file__)))
CLI = os.environ['ZC_CLI']
OUT = os.environ.get('OUT', '/work/out')
WORK = os.environ.get('WORK', 'C:/work')
NPM = WORK + '/npm'
APPDIR = os.environ.get('ZC_APPDIR', 'C:/ZCodeApp')
BUILTIN = APPDIR + '/resources/config/provider/zcode-builtin.json'
PYEXE = sys.executable
HOME = WORK + '/home'
PROJ = WORK + '/proj'
import shutil as _sh
NODE = _sh.which('node') or 'C:/Program Files/nodejs/node.exe'
ZCN = os.environ.get('ZC_NODE', APPDIR + '/ZCode.exe')
ZN = NPM + '/zn.cmd'
ZNCHECK = NPM + '/zn-gate.cmd'
NODE_COPY_DIR = WORK + '/nodeZN'
NODE_COPY = NODE_COPY_DIR + '/node.exe'
CFG = HOME + '/.zcode/cli/config.json'
PORT = 18080
REC = KIT + '/hook_recorder.py'
os.makedirs(OUT + '/cases', exist_ok=True)
RESULTS = []

AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'                      # AWS documentation example key (public, not real)
AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'  # AWS documentation example secret (public, not real)


def sh_env(extra=None, with_zn_path=True):
    BS = chr(92)
    sysr = os.environ.get('SystemRoot') or 'C:/Windows'
    pth = ((NPM.replace('/', BS) + ';C:' + BS + 'Program Files' + BS + 'nodejs;') if with_zn_path else '') + sysr + BS + 'System32;' + sysr + BS + 'System32' + BS + 'WindowsPowerShell' + BS + 'v1.0;' + sysr
    e = {'PATH': pth, 'SystemRoot': sysr, 'COMSPEC': os.environ.get('COMSPEC') or (sysr + BS + 'System32' + BS + 'cmd.exe'), 'PATHEXT': '.COM;.EXE;.BAT;.CMD', 'HOME': HOME, 'USERPROFILE': HOME,
         'APPDATA': HOME + '/AppData/Roaming', 'LOCALAPPDATA': HOME + '/AppData/Local', 'TEMP': WORK + '/tmp', 'TMP': WORK + '/tmp',
         'ZCODE_DATA_BASE_DIR': HOME, 'ZN_STATS': 'off', 'TMPDIR': WORK + '/tmp', 'ZN_TEST': 'FAKE_ENV_VALUE',
         'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'ELECTRON_RUN_AS_NODE': '1', 'ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE': BUILTIN}
    if extra:
        e.update(extra)
    return e


def runcmd(args, name, env=None, cwd=None, timeout=120):
    r = subprocess.run(args, capture_output=True, text=True, env=env or sh_env(), cwd=cwd or PROJ, timeout=timeout, shell=str(args[0]).lower().endswith('.cmd'))
    open('%s/%s.txt' % (OUT, name), 'w').write('$ %s\nrc=%d\n--stdout--\n%s\n--stderr--\n%s\n' % (' '.join(args), r.returncode, r.stdout, r.stderr))
    return r


class R:
    pass


def run_tty(args, name, env=None, cwd=None, timeout=90):
    """zn hooks install/uninstall refuse to run without a terminal (by design): give it a ConPTY (pywinpty)."""
    from winpty import PtyProcess
    cmdline = 'cmd.exe /c ' + ' '.join(('"%s"' % a.replace('/', chr(92))) if ' ' in a else a.replace('/', chr(92)) for a in args)
    p = PtyProcess.spawn(cmdline, cwd=(cwd or PROJ).replace('/', chr(92)), env=env or sh_env(), dimensions=(40, 160))
    buf = ''
    sent = 0
    t0 = time.time()
    while time.time() - t0 < timeout and p.isalive():
        try:
            d = p.read(4096)
        except EOFError:
            break
        except Exception:
            time.sleep(0.2)
            continue
        buf += d
        if sent < 5 and re.search(r'(\[y/N\]|\[Y/n\]|\(y/n\)|Continue\?|Proceed\?)', buf[-200:], re.I):
            p.write('y\r')
            sent += 1
    try:
        rc = p.wait() if p.isalive() else p.exitstatus
    except Exception:
        rc = 255
    if rc is None:
        rc = 255
    out = buf
    hdr = '$ (conpty) %s' % cmdline + chr(10) + 'rc=%s answers_sent=%d' % (rc, sent) + chr(10) + '--output--' + chr(10) + out + chr(10)
    open('%s/%s.txt' % (OUT, name), 'w').write(hdr)
    r = R()
    r.returncode, r.stdout, r.stderr = (rc if isinstance(rc, int) else 255), out, ''
    return r


def wj(path, o):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(o, open(path, 'w'), indent=1)


def provider_cfg():
    return {'schemaVersion': 1, 'config': {
        'providerConfigRules': {'providerRules': [{'providerId': 'fakeprov', 'providerName': 'Fake', 'config': {
            'group': 'standard-personal', 'access': {'type': 'api-key', 'apiKey': 'FAKE_KEY_123'},
            'api': {'type': 'openai-chat-completions', 'baseUrl': 'http://127.0.0.1:%d/v1' % PORT},
            'personalModelIds': ['fake-model']}}]},
        'modelConfigRules': {'providerModelRules': [], 'manualProviderModelRules': []},
        'defaultModelSelection': {'providerId': 'fakeprov', 'modelId': 'fake-model'}}}


def user_config():
    """The user's own config BEFORE zn: an own PreToolUse hook (Bash), an own Stop hook, an own MCP server."""
    return {'features': {'mcp': True},
            'hooks': {'enabled': True, 'events': {
                'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'process', 'command': PYEXE, 'args': [REC, 'user_pre'], 'timeoutMs': 15000}]}],
                'Stop': [{'hooks': [{'type': 'process', 'command': PYEXE, 'args': [REC, 'user_stop'], 'timeoutMs': 15000}]}]}},
            'mcp': {'servers': {'zn_fake': {'type': 'stdio', 'command': PYEXE, 'args': [KIT + '/mcp_echo.py', PROJ], 'enabled': True, 'timeoutMs': 30000}}}}


def reset_project():
    shutil.rmtree(PROJ, ignore_errors=True)
    os.makedirs(PROJ)
    open(PROJ + '/a.txt', 'w').write('hello world\n')
    open(PROJ + '/.env', 'w').write('API_KEY=FAKE_sk_live_0123456789abcdef0123456789abcdef\nDB_PASSWORD=FAKE_hunter2_not_real\n')
    os.makedirs(HOME + '/.aws', exist_ok=True)
    open(HOME + '/.aws/credentials', 'w').write('[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' % (AWS_KEY, AWS_SECRET))


def v(**o):
    d = {'command': 'ls', 'description': 'test', 'file_path': PROJ + '/a.txt', 'content': 'ZN_WRITTEN', 'text': 'hello'}
    d.update(o)
    return d


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def tool_msgs(prov_log):
    """tool-role messages of the LAST request the fake provider received."""
    last = None
    n = 0
    if os.path.exists(prov_log):
        for l in open(prov_log):
            try:
                o = json.loads(l)
            except Exception:
                continue
            if 'tail' in o:
                n += 1
                last = o['tail']
    msgs = [m['content'] for m in (last or []) if m['role'] == 'tool']
    return n, msgs


def run_zcode(name, steps, prompt='run the test', cfg_edit=None, with_zn_path=False, mode='yolo', timeout=150):
    cd = '%s/cases/%s' % (OUT, name)
    shutil.rmtree(cd, ignore_errors=True)
    os.makedirs(cd)
    reset_project()
    saved_cfg = open(CFG).read()
    if cfg_edit:
        c = json.load(open(CFG))
        cfg_edit(c)
        wj(CFG, c)
    shutil.copy(CFG, cd + '/config_used.json')
    wj(cd + '/scenario.json', {'steps': steps, 'final': 'done'})
    open(WORK + '/hook_mode', 'w').write('')
    prov = subprocess.Popen([sys.executable, KIT + '/fake_provider.py', '--port', str(PORT), '--scenario', cd + '/scenario.json', '--log', cd + '/provider.jsonl'],
                            stdout=open(cd + '/provider.out', 'w'), stderr=subprocess.STDOUT)
    time.sleep(0.7)
    env = sh_env({'ZC_HOOK_LOG': cd + '/hook.jsonl', 'ZC_HOOK_MODE': WORK + '/hook_mode', 'ZCODE_LOG_CONSOLE': '1'}, with_zn_path)
    args = [ZCN, CLI, '--prompt', prompt, '--cwd', PROJ, '--output-format', 'stream-json', '--no-color', '--mode', mode]
    t0 = time.time()
    try:
        r = subprocess.run(args, capture_output=True, text=True, env=env, timeout=timeout, cwd=PROJ)
        rc, so, se = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        rc, so, se = 'TIMEOUT', (e.stdout or ''), (e.stderr or '')
        if isinstance(so, bytes):
            so = so.decode()
        if isinstance(se, bytes):
            se = se.decode()
    prov.terminate()
    try:
        prov.wait(5)
    except Exception:
        prov.kill()
    if cfg_edit:
        open(CFG, 'w').write(saved_cfg)  # a per-case edit never leaks into the next case
    open(cd + '/stdout.txt', 'w').write(so)
    open(cd + '/stderr.txt', 'w').write(se)
    ev = [l for l in so.splitlines() if '"outcome"' in l and 'hookRunId' in l]
    open(cd + '/hook_events.txt', 'w').write('\n'.join(ev) + '\n')
    nreq, tmsgs = tool_msgs(cd + '/provider.jsonl')
    res = {'rc': rc, 'dur_s': round(time.time() - t0, 1), 'requests': nreq, 'tool_msgs': tmsgs,
           'proj_files': sorted(os.listdir(PROJ)), 'outcomes': re.findall(r'"outcome":"(\w+)"', '\n'.join(ev)), 'stdout': so, 'stderr': se}
    json.dump({k: v_ for k, v_ in res.items() if k not in ('stdout', 'stderr')}, open(cd + '/result.json', 'w'), indent=1)
    return res


def record(case, expected, observed, ok, evidence):
    RESULTS.append({'case': case, 'expected': expected, 'observed': observed, 'result': 'PASS' if ok else 'FAIL', 'evidence': evidence})
    print('RESULT %-5s %s | %s' % ('PASS' if ok else 'FAIL', case, observed), flush=True)


def has_zn(msgs):
    return any(re.search(r'\bzn\b', m, re.I) for m in msgs)


def short(msgs, n=220):
    return ' || '.join(m.replace('\n', ' ')[:n] for m in msgs) or '(no tool message)'


def write_summary():
    json.dump(RESULTS, open(OUT + '/results.json', 'w'), indent=1)
    with open(OUT + '/results.md', 'w') as f:
        f.write('| Case | Expected | Observed | Result | Evidence |\n|---|---|---|---|---|\n')
        for x in RESULTS:
            f.write('| %s | %s | %s | %s | %s |\n' % (x['case'], x['expected'], x['observed'].replace('|', '/').replace('\n', ' ')[:500], x['result'], x['evidence']))
    print('SUMMARY', sum(1 for x in RESULTS if x['result'] == 'PASS'), 'pass', sum(1 for x in RESULTS if x['result'] == 'FAIL'), 'fail')
    with open(OUT + '/summary.txt', 'w') as f:
        for x in RESULTS:
            f.write('%s | %s | %s\n' % (x['result'], x['case'], x['observed'][:300]))
