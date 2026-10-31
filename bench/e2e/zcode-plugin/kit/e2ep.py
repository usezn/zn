#!/usr/bin/env python3
"""zn-gate ZCode PLUGIN end to end inside the official ZCode runtime (app 3.16.3), fake local provider, FICTITIOUS values only.
Needs zc_helpers.py (the helpers of the adapter e2e), /work/market (the built plugin marketplace) and zn-gate installed
globally under /work/node (for `zn-gate check` and `zn hooks install`)."""
import os, sys, json, re, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zc_helpers import *  # noqa

MARKET = WORK + '/market'
PLUGIN_ID = 'zn-gate@usezn'
CACHE = HOME + '/.zcode/cli/plugins/cache/usezn/zn-gate'
INSTALLED = HOME + '/.zcode/cli/plugins/installed_plugins.json'


def base_config(hooks_enabled='absent', extra_hooks=None):
    c = {'features': {'mcp': True},
         'mcp': {'servers': {'zn_fake': {'type': 'stdio', 'command': 'python3', 'args': [KIT + '/mcp_echo.py'], 'enabled': True, 'timeoutMs': 30000}}}}
    if hooks_enabled != 'absent':
        c['hooks'] = {'enabled': hooks_enabled, 'events': extra_hooks or {}}
    return c


def zc(args, name, timeout=120):
    return runcmd([ZCN, CLI] + args, name, timeout=timeout)


def fresh(hooks_enabled='absent'):
    """A new ZCode user home: provider, config, no plugin."""
    shutil.rmtree(HOME, ignore_errors=True)
    os.makedirs(HOME, exist_ok=True)
    reset_project()
    wj(HOME + '/.zcode/v2/provider_config.json', provider_cfg())
    wj(CFG, base_config(hooks_enabled))


def add_plugin(tag):
    r1 = zc(['plugins', 'marketplace', 'add', MARKET], tag + '_marketplace_add')
    r2 = zc(['plugins', 'install', PLUGIN_ID], tag + '_install')
    r3 = zc(['plugins', 'list'], tag + '_list')
    return r1.returncode == 0 and r2.returncode == 0, r3.stdout


def kinds(res):
    """[(sourceKind, event, outcome)] from the stream-json hook events."""
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


def matrix(tag, label):
    """The scenarios that must hold when the plugin is the only protection."""
    res = run_zcode(tag + '_read_env', [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}])
    ok = has_zn(res['tool_msgs']) and 'FAKE_sk_live' not in short(res['tool_msgs'], 4000) and plugin_blocked(res)
    record(label + ' Read .env', 'denied by the plugin hook, value not returned', short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/%s_read_env' % tag)

    res = run_zcode(tag + '_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    ok = has_zn(res['tool_msgs']) and AWS_KEY not in short(res['tool_msgs'], 4000) and plugin_blocked(res)
    record(label + ' Bash cat ~/.aws/credentials', 'denied', short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/%s_aws' % tag)

    res = run_zcode(tag + '_benign', [{'tool': 'bash', 'values': v(command='ls')}, {'tool': 'read', 'values': v(file_path=PROJ + '/a.txt')}])
    j = short(res['tool_msgs'], 4000)
    ok = 'a.txt' in j and 'hello world' in j and not any(o == 'blocked' for _, _, o in kinds(res)) and not has_zn(res['tool_msgs']) and bool(kinds(res))
    record(label + ' benign ls + Read', 'allowed, no false block, the plugin hook ran', short(res['tool_msgs'], 120) + ' | ' + str(kinds(res)[:4]), ok, 'cases/%s_benign' % tag)

    res = run_zcode(tag + '_prompt', [{'tool': 'bash', 'values': v(command='ls')}], prompt='please deploy with key %s and secret %s' % (AWS_KEY, AWS_SECRET))
    ok = res['requests'] == 0 and plugin_blocked(res)
    record(label + ' prompt with FAKE secret', 'blocked by UserPromptSubmit, 0 model requests', 'requests=%d %s' % (res['requests'], kinds(res)), ok, 'cases/%s_prompt' % tag)

    res = run_zcode(tag + '_mcp', [{'tool': 'echo', 'values': v(text='hello')}])
    called = os.path.exists(PROJ + '/MCP_CALLED')
    ok = called and any('ECHO:hello' in m for m in res['tool_msgs']) and not any(o == 'blocked' for _, _, o in kinds(res))
    record(label + ' MCP benign', 'passes, runs', short(res['tool_msgs']) + ' | called=%s' % called, ok, 'cases/%s_mcp' % tag)
    res = run_zcode(tag + '_mcp_secret', [{'tool': 'echo', 'values': v(text='token ' + AWS_KEY)}])
    called = os.path.exists(PROJ + '/MCP_CALLED')
    ok = (not called) and has_zn(res['tool_msgs']) and plugin_blocked(res)
    record(label + ' MCP with a doc AWS key in args', 'denied, server not called', short(res['tool_msgs']) + ' | called=%s' % called, ok, 'cases/%s_mcp_secret' % tag)

    before = sha(CFG)
    res = run_zcode(tag + '_cfg', [{'tool': 'write', 'values': v(file_path=CFG, content='{}')}])
    ok = sha(CFG) == before and plugin_blocked(res)
    record(label + ' Write to ~/.zcode/cli/config.json', 'denied, file unchanged', short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/%s_cfg' % tag)


def main():
    os.makedirs(WORK + '/tmp', exist_ok=True)
    os.makedirs(HOME, exist_ok=True)
    reset_project()
    runcmd([ZCN, CLI, '--version'], 'zcode_version')

    # ---- A: install from the (local directory) marketplace, hooks.enabled=false
    fresh(False)
    ok, listing = add_plugin('a')
    inst = json.load(open(INSTALLED)) if os.path.exists(INSTALLED) else {}
    cfgj = json.load(open(CFG))
    en = cfgj.get('plugins', {}).get('enabledPlugins', {}).get(PLUGIN_ID)
    record('A0 install through the runtime plugin API', 'installed, enabled, 8 hooks listed (a /bin/sh and a PowerShell hook per event), no npm install needed',
           re.sub(r'\s+', ' ', listing)[:300] + ' | enabled=%s' % en, ok and en is True and 'hooks: 8' in listing, 'a_install.txt, a_list.txt')
    shutil.copy(CFG, OUT + '/config_a_after_install.json')
    shutil.copy(INSTALLED, OUT + '/installed_plugins_a.json')
    matrix('a', 'A (hooks.enabled=false)')

    # ---- B: hooks key absent (ZCode default is off), C: hooks.enabled=true with no user hooks
    for tag, he in (('b', 'absent'), ('c', True)):
        fresh(he)
        ok, listing = add_plugin(tag)
        if not ok:
            record(tag.upper() + '0 install', 'ok', 'failed', False, tag + '_install.txt')
            continue
        res = run_zcode(tag + '_read_env', [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}])
        record('%s (hooks.enabled=%s) Read .env' % (tag.upper(), he), 'denied by the plugin hook',
               short(res['tool_msgs']) + ' | ' + str(kinds(res)), has_zn(res['tool_msgs']) and plugin_blocked(res), 'cases/%s_read_env' % tag)
        res = run_zcode(tag + '_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
        record('%s (hooks.enabled=%s) cat ~/.aws/credentials' % (tag.upper(), he), 'denied', short(res['tool_msgs']) + ' | ' + str(kinds(res)),
               has_zn(res['tool_msgs']) and plugin_blocked(res), 'cases/%s_aws' % tag)

    # ---- D: the plugin disabled with hooks.enabled=false: nothing protects (and check must say so: run 2)
    fresh(False)
    add_plugin('d')
    r = zc(['plugins', 'disable', PLUGIN_ID], 'd_disable')
    en = json.load(open(CFG)).get('plugins', {}).get('enabledPlugins', {}).get(PLUGIN_ID)
    shutil.copy(CFG, OUT + '/config_d_disabled.json')
    res = run_zcode('d_disabled_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    ran = any(AWS_KEY in m for m in res['tool_msgs']) and not kinds(res)
    record('D plugin disabled + hooks.enabled=false', 'plugin state false in config, zn inert (documented: NOT protected)',
           'enabledPlugins[%s]=%s | key returned=%s kinds=%s' % (PLUGIN_ID, en, ran, kinds(res)), en is False and ran, 'cases/d_disabled_aws, config_d_disabled.json')
    r = zc(['plugins', 'enable', PLUGIN_ID], 'd_enable')
    res = run_zcode('d_reenabled_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    record('D2 plugin enabled again', 'blocks again', short(res['tool_msgs']) + ' | ' + str(kinds(res)), has_zn(res['tool_msgs']) and plugin_blocked(res), 'cases/d_reenabled_aws')

    # ---- E: uninstall
    r = zc(['plugins', 'uninstall', PLUGIN_ID, '--force'], 'e_uninstall')
    listing = zc(['plugins', 'list'], 'e_list').stdout
    inst = json.load(open(INSTALLED)) if os.path.exists(INSTALLED) else {}
    left = [p for p in inst.get('plugins', []) if p.get('id') == PLUGIN_ID]
    cache_left = os.path.exists(CACHE)
    enl = json.load(open(CFG)).get('plugins', {}).get('enabledPlugins', {})
    res = run_zcode('e_after_uninstall_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    ran = any(AWS_KEY in m for m in res['tool_msgs'])
    record('E uninstall', 'plugin gone from the list and from enabledPlugins, zn no longer runs (cache left on disk is informational)',
           'rc=%d listed=%s cache_left=%s enabled_entry=%s key_returned=%s' % (r.returncode, PLUGIN_ID in listing, cache_left, enl.get(PLUGIN_ID), ran),
           r.returncode == 0 and PLUGIN_ID not in listing and not left and PLUGIN_ID not in enl and ran, 'e_uninstall.txt, cases/e_after_uninstall_aws')

    # ---- F: tamper with the vendored zn-gate: fail closed, even for a benign call
    fresh(False)
    add_plugin('f')
    vend = glob_first(CACHE + '/*/vendor/zn-gate/lib/hooks/policy.js')
    with open(vend, 'a') as f:
        f.write('\n// tampered\n')
    res = run_zcode('f_tamper_benign', [{'tool': 'bash', 'values': v(command='touch %s/EXEC_MARK' % PROJ)}])
    ok = 'EXEC_MARK' not in res['proj_files'] and plugin_blocked(res)
    record('F vendored file changed', 'every call blocked (fail closed), reason names the changed file', short(res['tool_msgs'], 300) + ' | ' + str(kinds(res)), ok, 'cases/f_tamper_benign')

    # ---- G: no Node.js anywhere on the PATH of the hook (the app's own Node.js is used: parent program)
    fresh(False)
    add_plugin('g')
    res = run_zcode('g_no_node_in_path', [{'tool': 'read', 'values': v(file_path=PROJ + '/.env')}], with_zn_path=False)
    ok = has_zn(res['tool_msgs']) and plugin_blocked(res)
    record('G no node on the PATH of the hook', 'still checks (ZCode own Node.js) and denies', short(res['tool_msgs']) + ' | ' + str(kinds(res)), ok, 'cases/g_no_node_in_path')
    hook = glob_first(CACHE + '/*/scripts/zn-hook.sh')
    ev = json.dumps({'hook_event_name': 'PreToolUse', 'session_id': 's', 'cwd': PROJ, 'tool_name': 'Bash', 'tool_input': {'command': 'ls'}})
    import subprocess
    for evn, want in (('PreToolUse', 2), ('PostToolUse', 0)):
        r = subprocess.run(['/bin/sh', hook, evn], input=ev, capture_output=True, text=True, env={'PATH': '/nonexistent', 'HOME': HOME})
        open('%s/g_direct_no_node_%s.txt' % (OUT, evn), 'w').write('rc=%d\n%s\n%s' % (r.returncode, r.stdout, r.stderr))
        record('G2 hook script with no usable Node.js (%s)' % evn, 'exit %d with a reason' % want, 'rc=%d %s' % (r.returncode, r.stderr.strip()[:160]), r.returncode == want and 'zn' in r.stderr, 'g_direct_no_node_%s.txt' % evn)

    # ---- I: zn-gate check with the plugin (setup read + live run of the plugin hook)
    def check(name):
        r = runcmd([ZNCHECK, 'check'], name)
        return r.returncode, re.sub(r'\s+', ' ', r.stdout + r.stderr)

    fresh(False)
    add_plugin('i')
    rc, txt = check('i_check_plugin_only')
    record('I1 zn-gate check: plugin only, hooks.enabled=false', 'OK, via the plugin', 'rc=%d %s' % (rc, txt[txt.find('ZCode') - 5:][:260]), rc == 0 and bool(re.search(r'OK\s+ZCode', txt, re.I)), 'i_check_plugin_only.txt')
    zc(['plugins', 'disable', PLUGIN_ID], 'i_disable')
    rc, txt = check('i_check_plugin_off')
    record('I2 zn-gate check: plugin turned off, hooks.enabled=false', 'NOT protected, says the plugin is off', 'rc=%d %s' % (rc, txt[txt.find('ZCode') - 5:][:300]), rc != 0 and bool(re.search(r'NOT protected', txt)) and 'plugin is turned off' in txt, 'i_check_plugin_off.txt')
    zc(['plugins', 'enable', PLUGIN_ID], 'i_enable')

    # ---- J: double install (plugin + zn hooks install zcode)
    r = run_tty([ZN, 'hooks', 'install', 'zcode'], 'j_hooks_install')
    warned = 'checked twice' in r.stdout.replace(chr(10), ' ') or 'also installed' in r.stdout
    shutil.copy(CFG, OUT + '/config_j_double.json')
    cfgj = json.load(open(CFG))
    record('J1 zn hooks install zcode with the plugin on', 'rc 0 and a warning about the double run', 'rc=%d warned=%s enabledPlugins=%s' % (r.returncode, warned, cfgj.get('plugins')), r.returncode == 0 and warned, 'j_hooks_install.txt')
    rc, txt = check('j_check_both')
    record('J2 zn-gate check with both', 'protected, with a note that every call is checked twice', 'rc=%d %s' % (rc, txt[txt.find('ZCode') - 5:][:420]), rc == 0 and 'checked twice' in txt, 'j_check_both.txt')
    res = run_zcode('j_double_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    k = kinds(res)
    src = sorted(set(a for a, b, c in k if b == 'PreToolUse'))
    pre = [(a, c) for a, b, c in k if b == 'PreToolUse']
    record('J3 double install: the call is checked by both and blocked', 'user and plugin hooks both run on PreToolUse, the call is blocked once',
           str(pre) + ' tool_msgs=' + short(res['tool_msgs'], 120), src == ['plugin', 'user'] and any(c == 'blocked' for _, c in pre) and not any(AWS_KEY in m for m in res['tool_msgs']), 'cases/j_double_aws')
    # K: the plugin off, hooks on: still protected by the hooks (and check says the plugin is off)
    zc(['plugins', 'disable', PLUGIN_ID], 'k_disable')
    res = run_zcode('k_hooks_only_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    k = kinds(res)
    record('K plugin off + zn hooks on', 'blocked by the user hooks only', str(k), any(a == 'user' and c == 'blocked' for a, b, c in k) and not any(a == 'plugin' for a, _, _ in k), 'cases/k_hooks_only_aws')
    rc, txt = check('k_check_hooks_only')
    record('K2 zn-gate check, plugin off + hooks on', 'protected, notes the plugin is off', 'rc=%d %s' % (rc, txt[txt.find('ZCode') - 5:][:320]), rc == 0 and 'turned off' in txt, 'k_check_hooks_only.txt')
    c2 = json.load(open(CFG))
    c2['hooks']['enabled'] = False
    wj(CFG, c2)
    rc, txt = check('k_check_nothing')
    record('K3 zn-gate check, plugin off + hooks.enabled=false', 'NOT protected', 'rc=%d %s' % (rc, txt[txt.find('ZCode') - 5:][:320]), rc != 0 and 'NOT protected' in txt, 'k_check_nothing.txt')
    r = run_tty([ZN, 'hooks', 'uninstall', 'zcode'], 'k_hooks_uninstall')
    zc(['plugins', 'enable', PLUGIN_ID], 'k_enable')

    # ---- U: update (a new plugin version in the marketplace), then a new session
    mf = MARKET + '/zn-gate/.zcode-plugin/plugin.json'
    m = json.load(open(mf))
    old = m['version']
    m['version'] = old + '-test.1'
    wj(mf, m)
    ru = zc(['plugins', 'marketplace', 'update'], 'u_marketplace_update')
    ru2 = zc(['plugins', 'update', PLUGIN_ID], 'u_update')
    listing = zc(['plugins', 'list'], 'u_list').stdout
    res = run_zcode('u_after_update_aws', [{'tool': 'bash', 'values': v(command='cat ~/.aws/credentials')}])
    record('U update to a new plugin version', 'the new version is installed and still blocks in a new session',
           'old=%s rc=%d/%d listing=%s' % (old, ru.returncode, ru2.returncode, re.sub(r'\s+', ' ', listing[listing.find('zn-gate@'):][:200])), (old + '-test.1') in listing and plugin_blocked(res), 'u_*.txt, cases/u_after_update_aws')
    m['version'] = old
    wj(mf, m)

    # ---- H: hook latency from the stream events (the plugin runs 2 hooks per tool call)
    fresh(False)
    add_plugin('h')
    res = run_zcode('h_latency', [{'tool': 'bash', 'values': v(command='ls')}, {'tool': 'read', 'values': v(file_path=PROJ + '/a.txt')}])
    durs = [int(x) for x in re.findall(r'"durationMs":(\d+)', res['stdout'])]
    record('H hook latency (info)', 'observe only', 'durationMs of hook runs: %s' % durs, bool(durs), 'cases/h_latency')


def glob_first(pat):
    import glob
    g = sorted(glob.glob(pat))
    if not g:
        raise SystemExit('no file for ' + pat)
    return g[0]


if __name__ == '__main__':
    try:
        main()
    finally:
        write_summary()
