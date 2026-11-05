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


def add_plugin(tag, market=MARKET):
    r1 = zc(['plugins', 'marketplace', 'add', market], tag + '_marketplace_add')
    r2 = zc(['plugins', 'install', PLUGIN_ID], tag + '_install')
    r3 = zc(['plugins', 'list'], tag + '_list')
    return r1.returncode == 0 and r2.returncode == 0, r3.stdout


def is_win_hook(h):
    c = h['command'].lower()
    return 'powershell' in c or c.endswith('cmd.exe') or c.endswith('zn-hook-win.cmd')


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
    return 'type "' + HOME.replace('/', BS) + BS + '.aws' + BS + 'credentials"'


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
    n_ps = sum(1 for ev in hj['hooks'].values() for g in ev for h in g['hooks'] if is_win_hook(h))
    n_sh = sum(1 for ev in hj['hooks'].values() for g in ev for h in g['hooks'] if h['command'] == '/bin/sh')
    record('A1 installed copy has both hooks per event', '4 events x (1 /bin/sh + 1 Windows launcher)', 'sh=%d windows=%d dir=%s' % (n_sh, n_ps, plugdir), n_ps == 4 and n_sh == 4, 'cached_hooks.json')

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
    hook = [h for g in hj['hooks']['PreToolUse'] for h in g['hooks'] if is_win_hook(h)][0]
    hook_post = [h for g in hj['hooks']['PostToolUse'] for h in g['hooks'] if is_win_hook(h)][0]
    sysr = os.environ.get('SystemRoot') or 'C:' + BS + 'Windows'

    def direct(h, evn, path, tag):
        e = {'SystemRoot': sysr, 'PATH': path, 'USERPROFILE': HOME.replace('/', BS), 'ZCODE_PLUGIN_ROOT': plugdir.replace('/', BS), 'TEMP': WORK.replace('/', BS) + BS + 'tmp'}
        evj = json.dumps({'hook_event_name': evn, 'session_id': 's', 'cwd': PROJ, 'tool_name': 'Bash', 'tool_input': {'command': 'dir'}})
        cmdp = h['command'].replace('${ZCODE_PLUGIN_ROOT}', plugdir.replace('/', BS)).replace('/', BS)
        if cmdp.lower().endswith('.cmd'):
            # the way a host starts the launcher: cmd.exe on the file (no shell metacharacters in the fixed arguments)
            line = 'cmd.exe /d /s /c ""%s" %s"' % (cmdp, ' '.join(h['args']))
            r = subprocess.run(line, input=evj, capture_output=True, text=True, env=e, cwd=PROJ, timeout=90)
        else:
            # as ZCode starts a process hook: ${ZCODE_PLUGIN_ROOT} filled in, no shell
            args = [a.replace('${ZCODE_PLUGIN_ROOT}', plugdir.replace('/', BS)) for a in h['args']]
            r = subprocess.run([h['command']] + args, input=evj, capture_output=True, text=True, env=e, cwd=PROJ, timeout=90)
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
    # D6: Node.js is installed but the hook PATH has no Node.js and the environment has no ProgramFiles (the hook environment of the
    # app); the test process (python.exe) is the only ancestor and is not Node.js: the hook must block, never exit 0.
    r = direct(hook, 'PreToolUse', sysonly, 'cmd_no_node_on_path')
    record('D6 launcher .cmd, Node.js not on the PATH, no node.exe ancestor', 'exit 2 with a zn reason (never 0)', 'rc=%d %s' % (r.returncode, r.stderr.strip()[:200]),
           r.returncode == 2 and 'zn' in r.stderr and 'Microsoft Windows' not in r.stdout, 'd_direct_cmd_no_node_on_path_PreToolUse.txt')
    r = direct(hook, 'PreToolUse', NODEDIR + ';' + sysonly, 'withnode')
    record('D5 (control) hook entry with Node.js back, ordinary call', 'exit 0 (allowed)', 'rc=%d %s' % (r.returncode, r.stderr.strip()[:200]), r.returncode == 0, 'd_direct_withnode_PreToolUse.txt')

    # ---- H: hook latency from the stream events
    fresh(False)
    add_plugin('h')
    res = run_zcode('h_latency', [{'tool': 'bash', 'values': v(command='dir')}, {'tool': 'read', 'values': v(file_path=PROJ + '/a.txt')}])
    durs = [int(x) for x in re.findall(r'"durationMs":(\d+)', res['stdout'])]
    record('H hook latency (info)', 'observe only', 'durationMs of hook runs: %s' % durs, bool(durs), 'cases/h_latency')

    if os.environ.get('E2E_EXTRA') == '1':
        extra(sysr, sysonly)


def plugin_durations(res):
    """(event, outcome, durationMs) of the plugin's hook runs."""
    out = []
    for l in res['stdout'].splitlines():
        if 'hookRunId' not in l or '"outcome"' not in l or '"sourceKind":"plugin"' not in l:
            continue
        if 'zn-hook.sh' in l:  # the POSIX entry, which cannot start on Windows
            continue
        e = re.search(r'"hookEventName":"(\w+)"', l)
        o = re.search(r'"outcome":"(\w+)"', l)
        d = re.search(r'"durationMs":(\d+)', l)
        out.append((e.group(1) if e else '?', o.group(1) if o else '?', int(d.group(1)) if d else -1))
    return out


def started_from(folder, since):
    """Programs started from inside `folder` since `since` (Windows process creation audit, event 4688)."""
    ps = (os.environ.get('SystemRoot') or 'C:' + BS + 'Windows') + BS + 'System32' + BS + 'WindowsPowerShell' + BS + 'v1.0' + BS + 'powershell.exe'
    q = ("$s=[DateTime]::Parse('%s'); Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4688; StartTime=$s} -ErrorAction SilentlyContinue | "
         "ForEach-Object { $_.Properties[5].Value }" % since)
    r = subprocess.run([ps, '-NoProfile', '-Command', q], capture_output=True, text=True, timeout=120)
    f = folder.replace('/', BS).lower()
    allp = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    return [p for p in allp if p.lower().startswith(f)], len(allp)


def extra(sysr, sysonly):
    """Cases in the app that the folder runs do not cover: a hook that hangs, a node.exe planted in the project with the PATH
    pointing there, and an environment without ProgramFiles, SystemRoot or ZCODE_PLUGIN_ROOT."""
    import datetime
    pf = {'ProgramFiles': 'C:' + BS + 'Program Files'}
    # ---- I1-I3: the verified zn-gate copy of the plugin hangs (a plugin build whose runner never answers, its lock updated)
    # zn-gate hangs only on PreToolUse there, so the prompt goes through and the Read of .env is what the deadline has to block.
    for num, tag, market, env_extra, label in [('1', 'i_hang_async_fast', WORK + '/market-hang-async', pf, 'never answers, direct Node.js path'),
                                               ('2', 'i_hang_sync_fast', WORK + '/market-hang-sync', pf, 'never gives its thread back, direct Node.js path'),
                                               ('3', 'i_hang_sync_ps', WORK + '/market-hang-sync', {}, 'never gives its thread back, PowerShell path')]:
        case = 'I%s zn-gate inside the plugin hangs on PreToolUse: Read .env (%s)' % (num, label)
        expect = 'blocked by the hook at its 26 second deadline, before ZCode\'s 30 second timeout; value not returned'
        if not os.path.isdir(market):
            record(case, expect, 'the kit has no ' + market, False, '')
            continue
        fresh(False)
        add_plugin(tag, market)
        res = run_zcode(tag, [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}], env_extra=env_extra, timeout=240)
        runs = plugin_durations(res)
        pre = [(o, d) for e, o, d in runs if e == 'PreToolUse']
        msgs = short(res['tool_msgs'], 4000)
        ok = bool(pre) and all(o == 'blocked' and (d < 0 or 20000 <= d < 29000) for o, d in pre) and 'FAKE_sk_live' not in msgs and res['requests'] > 0
        record(case, expect, short(res['tool_msgs']) + ' | plugin hook runs (event, outcome, ms): %s' % runs, ok, 'cases/' + tag)
    # back to the real plugin
    fresh(False)
    add_plugin('i_back')

    # ---- I4-I5: node.exe planted in the project, the PATH and the folder of the hook pointing into the project
    node_real = NODEDIR + BS + 'node.exe'
    pj = PROJ.replace('/', BS)

    def plant():
        for d in [pj, pj + BS + 'bin', pj + BS + 'node_modules' + BS + '.bin']:
            os.makedirs(d, exist_ok=True)
            shutil.copy(node_real, d + BS + 'node.exe')
        os.makedirs(pj + BS + '.git', exist_ok=True)
    planted_path = '.;bin;' + pj + BS + 'bin;' + pj + BS + 'node_modules' + BS + '.bin;' + sysr + BS + 'System32;' + sysr
    for tag, env_extra, label in [('i_planted_ps', {'PATH': planted_path}, 'no ProgramFiles: PowerShell path, which looks for Node.js'),
                                  ('i_planted_fast', dict(pf, PATH=planted_path), 'ProgramFiles set: direct Node.js path')]:
        since = datetime.datetime.now().isoformat()
        res = run_zcode(tag, [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}, {'tool': 'read', 'values': v(file_path=PROJ + '/a.txt')}], env_extra=env_extra, prep=plant)
        ran, n = started_from(PROJ, since)
        msgs = short(res['tool_msgs'], 4000)
        ok = has_zn(res['tool_msgs']) and plugin_blocked(res) and 'FAKE_sk_live' not in msgs and 'hello world' in msgs and not ran and n > 0
        record('I%s node.exe planted in the project, PATH into the project (%s): Read .env, Read a.txt' % ({'i_planted_ps': '4', 'i_planted_fast': '5'}[tag], label),
               '.env denied by the plugin, a.txt allowed, no program in the project started (process audit)',
               short(res['tool_msgs']) + ' | started from the project: %s (of %d audited)' % (ran, n), ok, 'cases/' + tag)

    # ---- I6: the app without ProgramFiles and SystemRoot in its environment
    res = run_zcode('i_no_sysroot', [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}], env_drop=('SystemRoot', 'ProgramFiles', 'ZCODE_PLUGIN_ROOT'))
    msgs = short(res['tool_msgs'], 4000)
    if res['requests'] == 0 and not [k for k in kinds(res) if k[1] != 'UserPromptSubmit']:
        record('I6 (info) the app without SystemRoot and ProgramFiles: Read .env', 'observe only',
               'the app made no model request and ran no hook (rc=%s): nothing ran; see I7 for the hook itself' % res['rc'], True, 'cases/i_no_sysroot')
    else:
        ok = plugin_blocked(res) and 'FAKE_sk_live' not in msgs
        record('I6 the app without SystemRoot and ProgramFiles: Read .env', 'denied by the plugin, value not returned', msgs[:300] + ' | ' + str(kinds(res)), ok, 'cases/i_no_sysroot')

    # ---- I7: the hook entry started as ZCode starts it, with no SystemRoot, ProgramFiles or ZCODE_PLUGIN_ROOT
    plugdir = glob_first(CACHE + '/*')
    hj = json.load(open(plugdir + '/hooks/hooks.json'))
    h = [x for g in hj['hooks']['PreToolUse'] for x in g['hooks'] if is_win_hook(x)][0]
    args = [a.replace('${ZCODE_PLUGIN_ROOT}', plugdir.replace('/', BS)) for a in h['args']]
    for tag, path, file_path, want in [('nopath', sysonly, PROJ + '/a.txt', 2), ('node', NODEDIR + ';' + sysonly, PROJ + '/.env', 2), ('node_ok', NODEDIR + ';' + sysonly, PROJ + '/a.txt', 0)]:
        e = {'PATH': path, 'USERPROFILE': HOME.replace('/', BS), 'TEMP': WORK.replace('/', BS) + BS + 'tmp'}
        evj = json.dumps({'hook_event_name': 'PreToolUse', 'session_id': 's', 'cwd': PROJ, 'tool_name': 'Read', 'tool_input': {'file_path': file_path}})
        t0 = time.time()
        r = subprocess.run([h['command']] + args, input=evj, capture_output=True, text=True, env=e, cwd=PROJ, timeout=90)
        ms = int((time.time() - t0) * 1000)
        open('%s/i7_direct_%s.txt' % (OUT, tag), 'w').write('rc=%d ms=%d\n--stdout--\n%s\n--stderr--\n%s\n' % (r.returncode, ms, r.stdout, r.stderr))
        denied = r.returncode == 2 or '"deny"' in r.stdout
        ok = (denied and 'zn' in (r.stdout + r.stderr)) if want == 2 else (r.returncode == 0 and '"deny"' not in r.stdout)
        record('I7 hook entry without SystemRoot, ProgramFiles and ZCODE_PLUGIN_ROOT (%s, %s)' % (tag, os.path.basename(file_path)),
               'blocked with a zn reason' if want == 2 else 'allowed (exit 0)', 'rc=%d %d ms %s' % (r.returncode, ms, (r.stderr + r.stdout).strip()[:200]), ok, 'i7_direct_%s.txt' % tag)


if __name__ == '__main__':
    try:
        main()
    finally:
        write_summary()
