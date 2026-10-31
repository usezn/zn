#!/usr/bin/env python3
"""zn-gate ZCode PLUGIN on Windows, end to end inside the official ZCode runtime (app 3.16.3), fake local provider,
FICTITIOUS values only. Needs zc_helpers_win.py, WORK/market (the built plugin marketplace) and zn-gate installed under
WORK/npm (for `zn-gate check`)."""
import os, sys, json, re, shutil, glob, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zc_helpers_win import *  # noqa

BS = chr(92)
MARKET = WORK + '/market'
PLUGIN_ID = 'zn-gate@usezn'
CACHE = HOME + '/.zcode/cli/plugins/cache/usezn/zn-gate'
INSTALLED = HOME + '/.zcode/cli/plugins/installed_plugins.json'
NODEDIR = 'C:' + BS + 'Program Files' + BS + 'nodejs'


def zc(args, name, timeout=120):
    return runcmd([ZCN, CLI] + args, name, timeout=timeout)


def fresh(hooks_enabled='absent'):
    shutil.rmtree(HOME, ignore_errors=True)
    os.makedirs(HOME, exist_ok=True)
    reset_project()
    wj(HOME + '/.zcode/v2/provider_config.json', provider_cfg())
    c = {'features': {'mcp': True},
         'mcp': {'servers': {'zn_fake': {'type': 'stdio', 'command': PYEXE, 'args': [KIT + '/mcp_echo.py', PROJ], 'enabled': True, 'timeoutMs': 30000}}}}
    if hooks_enabled != 'absent':
        c['hooks'] = {'enabled': hooks_enabled, 'events': {}}
    wj(CFG, c)


def add_plugin(tag):
    r1 = zc(['plugins', 'marketplace', 'add', MARKET], tag + '_marketplace_add')
    r2 = zc(['plugins', 'install', PLUGIN_ID], tag + '_install')
    r3 = zc(['plugins', 'list'], tag + '_list')
    return r1.returncode == 0 and r2.returncode == 0, r3.stdout


def hook_events(res):
    out = []
    for l in res['stdout'].splitlines():
        if 'hookRunId' not in l or '"outcome"' not in l:
            continue
        try:
            out.append(json.loads(l))
        except Exception:
            pass
    return out


def kinds(res):
    out = []
    for l in res['stdout'].splitlines():
        if 'hookRunId' not in l or '"outcome"' not in l:
            continue
        k = re.search(r'"sourceKind":"(\w+)"', l)
        o = re.search(r'"outcome":"(\w+)"', l)
        e = re.search(r'"hookEventName":"(\w+)"', l)
        out.append((k.group(1) if k else '?', e.group(1) if e else '?', o.group(1) if o else '?'))
    return out


def plugin_blocked(res):
    return any(k == 'plugin' and o == 'blocked' for k, _, o in kinds(res))


def refusal(msgs):
    return any('could not run' in m or 'launcher' in m and 'missing' in m or 'no Node.js' in m for m in msgs)


def glob_first(pat):
    g = sorted(glob.glob(pat))
    if not g:
        raise SystemExit('no file for ' + pat)
    return g[0]


def awscmd():
    return 'type ' + HOME.replace('/', BS) + BS + '.aws' + BS + 'credentials'


def main():
    os.makedirs(WORK + '/tmp', exist_ok=True)
    reset_project()
    runcmd([ZCN, CLI, '--version'], 'zcode_version')
    runcmd([ZNCHECK, '--version'], 'zn_gate_version')

    # ---- A: install from the (local directory) marketplace through the runtime plugin API, hooks.enabled=false
    fresh(False)
    ok, listing = add_plugin('a')
    en = json.load(open(CFG)).get('plugins', {}).get('enabledPlugins', {}).get(PLUGIN_ID)
    record('A0 install through the runtime plugin API', 'installed and enabled through the runtime, hooks listed',
           re.sub(r'\s+', ' ', listing)[:300] + ' | enabled=%s' % en, ok and en is True and 'hooks:' in listing, 'a_install.txt, a_list.txt')
    shutil.copy(CFG, OUT + '/config_a_after_install.json')
    shutil.copy(INSTALLED, OUT + '/installed_plugins_a.json')
    plugdir = glob_first(CACHE + '/*')
    hj = json.load(open(plugdir + '/hooks/hooks.json'))
    shutil.copy(plugdir + '/hooks/hooks.json', OUT + '/cached_hooks.json')
    n_ps = sum(1 for ev in hj['hooks'].values() for g in ev for h in g['hooks'] if 'powershell' in h['command'].lower())
    n_sh = sum(1 for ev in hj['hooks'].values() for g in ev for h in g['hooks'] if h['command'] == '/bin/sh')
    record('A1 installed copy has both hooks per event', '4 events x (1 /bin/sh + 1 PowerShell)', 'sh=%d powershell=%d dir=%s' % (n_sh, n_ps, plugdir), n_ps == 4 and n_sh == 4, 'cached_hooks.json')

    # ---- (a)+(b): Read .env and the AWS credentials are blocked by the plugin (so the PowerShell entry started and found its root)
    res = run_zcode('b_read_env', [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}])
    ev = hook_events(res)
    open(OUT + '/b_read_env_hook_events.json', 'w').write(json.dumps(ev, indent=1))
    ok = has_zn(res['tool_msgs']) and 'FAKE_sk_live' not in short(res['tool_msgs'], 4000) and plugin_blocked(res) and not refusal(res['tool_msgs'])
    record('B1 Read .env', 'denied by the plugin hook with the zn reason (not a launcher refusal), value not returned',
           short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/b_read_env, b_read_env_hook_events.json')
    res = run_zcode('b_aws_bash', [{'tool': 'bash', 'values': v(command=awscmd())}])
    ok = has_zn(res['tool_msgs']) and AWS_KEY not in short(res['tool_msgs'], 4000) and plugin_blocked(res) and not refusal(res['tool_msgs'])
    record('B2 Bash type %USERPROFILE%\\.aws\\credentials', 'denied by the plugin hook, key not returned', short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/b_aws_bash')
    res = run_zcode('b_aws_read', [{'tool': 'read', 'values': v(file_path=HOME + '/.aws/credentials')}])
    ok = has_zn(res['tool_msgs']) and AWS_KEY not in short(res['tool_msgs'], 4000) and plugin_blocked(res)
    record('B3 Read ~/.aws/credentials', 'denied by the plugin hook, key not returned', short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/b_aws_read')

    # ---- (c): an ordinary command runs; the PowerShell hook ran and let it through
    res = run_zcode('c_benign', [{'tool': 'bash', 'values': v(command='dir')}, {'tool': 'read', 'values': v(file_path=PROJ + '/a.txt')}])
    j = short(res['tool_msgs'], 4000)
    ok = 'a.txt' in j and 'hello world' in j and not any(o == 'blocked' for _, _, o in kinds(res)) and not has_zn(res['tool_msgs']) and bool(kinds(res))
    record('C ordinary dir + Read a.txt', 'allowed, no false block, the plugin hooks ran', short(res['tool_msgs'], 120) + ' | ' + str(kinds(res)[:8]), ok, 'cases/c_benign')

    res = run_zcode('c_prompt', [{'tool': 'bash', 'values': v(command='dir')}], prompt='please deploy with key %s and secret %s' % (AWS_KEY, AWS_SECRET))
    ok = res['requests'] == 0 and plugin_blocked(res)
    record('C2 prompt with FAKE secret', 'blocked by UserPromptSubmit, 0 model requests', 'requests=%d %s' % (res['requests'], kinds(res)), ok, 'cases/c_prompt')

    res = run_zcode('c_mcp_secret', [{'tool': 'echo', 'values': v(text='token ' + AWS_KEY)}])
    called = os.path.exists(PROJ + '/MCP_CALLED')
    ok = (not called) and has_zn(res['tool_msgs']) and plugin_blocked(res)
    record('C3 MCP call with a doc AWS key in args', 'denied, server not called', short(res['tool_msgs']) + ' | called=%s' % called, ok, 'cases/c_mcp_secret')

    # ---- (e): zn-gate check (plugin only, hooks.enabled=false)
    def check(name):
        r = runcmd([ZNCHECK, 'check'], name)
        return r.returncode, re.sub(r'\s+', ' ', r.stdout + r.stderr)

    rc, txt = check('e_check_plugin_only')
    record('E1 zn-gate check: plugin only, hooks.enabled=false', 'OK ZCode, protected via the plugin', 'rc=%d %s' % (rc, txt[max(0, txt.find('ZCode') - 5):][:300]),
           rc == 0 and bool(re.search(r'OK\s+ZCode', txt, re.I)), 'e_check_plugin_only.txt')
    zc(['plugins', 'disable', PLUGIN_ID], 'e_disable')
    rc, txt = check('e_check_plugin_off')
    record('E2 zn-gate check: plugin turned off', 'NOT protected, says the plugin is off', 'rc=%d %s' % (rc, txt[max(0, txt.find('ZCode') - 5):][:300]),
           rc != 0 and bool(re.search(r'NOT protected', txt)) and 'plugin is turned off' in txt, 'e_check_plugin_off.txt')
    zc(['plugins', 'enable', PLUGIN_ID], 'e_enable')

    # ---- (d): Node.js missing. Hook PATH without Node.js and Node.js out of its usual folder.
    hook = [h for g in hj['hooks']['PreToolUse'] for h in g['hooks'] if 'powershell' in h['command'].lower()][0]
    hook_post = [h for g in hj['hooks']['PostToolUse'] for h in g['hooks'] if 'powershell' in h['command'].lower()][0]
    sysr = os.environ.get('SystemRoot') or 'C:' + BS + 'Windows'

    def direct(h, evn, path, tag):
        e = {'SystemRoot': sysr, 'PATH': path, 'USERPROFILE': HOME.replace('/', BS), 'ZCODE_PLUGIN_ROOT': plugdir.replace('/', BS), 'TEMP': WORK.replace('/', BS) + BS + 'tmp'}
        evj = json.dumps({'hook_event_name': evn, 'session_id': 's', 'cwd': PROJ, 'tool_name': 'Bash', 'tool_input': {'command': 'dir'}})
        r = subprocess.run([h['command']] + h['args'], input=evj, capture_output=True, text=True, env=e, cwd=PROJ, timeout=90)
        open('%s/d_direct_%s_%s.txt' % (OUT, tag, evn), 'w').write('rc=%d\n--stdout--\n%s\n--stderr--\n%s\n' % (r.returncode, r.stdout, r.stderr))
        return r

    sysonly = sysr + BS + 'System32;' + sysr + BS + 'System32' + BS + 'WindowsPowerShell' + BS + 'v1.0'
    moved = NODEDIR + '.gone'
    try:
        os.rename(NODEDIR, moved)
        hid = True
    except Exception as ex:
        hid = False
        print('could not move node', ex)
    try:
        r = direct(hook, 'PreToolUse', sysonly, 'nonode')
        record('D1 hook entry, no usable Node.js (PreToolUse)', 'exit 2 with a zn reason, call not let through', 'node_hidden=%s rc=%d %s' % (hid, r.returncode, r.stderr.strip()[:200]),
               hid and r.returncode == 2 and 'zn' in r.stderr, 'd_direct_nonode_PreToolUse.txt')
        r = direct(hook_post, 'PostToolUse', sysonly, 'nonode')
        record('D2 hook entry, no usable Node.js (PostToolUse)', 'exit 0 with a warning (nothing left to block)', 'rc=%d %s' % (r.returncode, r.stderr.strip()[:200]),
               hid and r.returncode == 0 and 'NOT protecting' in r.stderr, 'd_direct_nonode_PostToolUse.txt')
        # in the app: Node.js gone from the PATH and from its folder; the app's own Node.js still lets the plugin check
        res = run_zcode('d_app_nonode_read_env', [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}], with_zn_path=False)
        ok = has_zn(res['tool_msgs']) and plugin_blocked(res) and 'FAKE_sk_live' not in short(res['tool_msgs'], 4000)
        record('D3 in the app, Node.js uninstalled and off the PATH: Read .env', 'still denied (the plugin falls back to the app own Node.js), never let through',
               short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/d_app_nonode_read_env')
        res = run_zcode('d_app_nonode_benign', [{'tool': 'bash', 'values': v(command='dir')}], with_zn_path=False)
        record('D4 (info) same setup, ordinary dir', 'observe only', short(res['tool_msgs'], 120) + ' | ' + str(kinds(res)), True, 'cases/d_app_nonode_benign')
    finally:
        if hid:
            os.rename(moved, NODEDIR)
    r = direct(hook, 'PreToolUse', NODEDIR + ';' + sysonly, 'withnode')
    record('D5 (control) hook entry with Node.js back, ordinary call', 'exit 0 (allowed)', 'rc=%d %s' % (r.returncode, r.stderr.strip()[:200]), r.returncode == 0, 'd_direct_withnode_PreToolUse.txt')

    # ---- H: hook latency from the stream events
    fresh(False)
    add_plugin('h')
    res = run_zcode('h_latency', [{'tool': 'bash', 'values': v(command='dir')}, {'tool': 'read', 'values': v(file_path=PROJ + '/a.txt')}])
    durs = [int(x) for x in re.findall(r'"durationMs":(\d+)', res['stdout'])]
    record('H hook latency (info)', 'observe only', 'durationMs of hook runs: %s' % durs, bool(durs), 'cases/h_latency')


if __name__ == '__main__':
    try:
        main()
    finally:
        write_summary()
