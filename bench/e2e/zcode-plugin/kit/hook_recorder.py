#!/usr/bin/env python3
"""Recording hook (FICTITIOUS test). argv[1]=label. Logs stdin JSON + env + cwd + parent cmdline to $ZC_HOOK_LOG.
Behaviour from file $ZC_HOOK_MODE (default /work/hook_mode): lines 'EVENT:mode' ; '*:mode' for all.
modes: allow exit2 exit1 crash jsondeny jsonask jsonallow topblock bad ctx sleep update exit2json"""
import sys, os, json, time

raw = sys.stdin.read()
label = sys.argv[1] if len(sys.argv) > 1 else '?'
try:
    ev = json.loads(raw)
except Exception:
    ev = {}
name = ev.get('hook_event_name') or ev.get('hookEventName') or ev.get('event') or '?'


def ppcmd():
    try:
        pp = os.getppid()
        return open('/proc/%d/cmdline' % pp, 'rb').read().replace(b'\0', b' ').decode()
    except Exception as e:
        return 'ERR %s' % e


keep = {k: v for k, v in os.environ.items() if k.startswith('ZCODE') or k in ('PWD', 'HOME', 'SHELL', 'USER', 'PATH', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'ZN_TEST')}
with open(os.environ.get('ZC_HOOK_LOG', '/work/hook.jsonl'), 'a') as f:
    f.write(json.dumps({'t': time.time(), 'label': label, 'argv': sys.argv, 'event': name, 'stdin_raw': raw[:6000],
                        'stdin_isatty': sys.stdin.isatty(), 'cwd': os.getcwd(), 'ppid_cmdline': ppcmd(),
                        'env_keys': sorted(os.environ.keys()), 'env_sel': keep}, ensure_ascii=False) + '\n')
mode = 'allow'
try:
    for l in open(os.environ.get('ZC_HOOK_MODE', '/work/hook_mode')):
        l = l.strip()
        if not l or ':' not in l:
            continue
        e, m = l.split(':', 1)
        if e in ('*', name):
            mode = m
except Exception:
    pass


def out(o):
    sys.stdout.write(json.dumps(o))


def hso(**k):
    return {'hookSpecificOutput': dict(hookEventName=name, **k)}


if mode == 'exit2':
    sys.stderr.write('ZN_TEST_STDERR_BLOCK: blocked by test hook (stderr text)\n')
    sys.exit(2)
elif mode == 'exit2json':
    out(hso(permissionDecision='allow'))
    sys.stderr.write('ZN_TEST_STDERR_EXIT2JSON\n')
    sys.exit(2)
elif mode == 'exit1':
    sys.stderr.write('ZN_TEST_STDERR_EXIT1\n')
    sys.exit(1)
elif mode == 'crash':
    raise RuntimeError('ZN_TEST_CRASH')
elif mode == 'jsondeny':
    out(hso(permissionDecision='deny', permissionDecisionReason='ZN_TEST_REASON_JSON_DENY'))
elif mode == 'jsonask':
    out(hso(permissionDecision='ask', permissionDecisionReason='ZN_TEST_REASON_ASK'))
elif mode == 'jsonallow':
    out(hso(permissionDecision='allow', permissionDecisionReason='ZN_TEST_REASON_ALLOW'))
elif mode == 'topblock':
    out({'decision': 'block', 'reason': 'ZN_TEST_TOP_BLOCK'})
elif mode == 'bad':
    sys.stdout.write('{not json ZN_TEST_BADOUT')
elif mode == 'plain':
    sys.stdout.write('ZN_TEST_PLAIN_STDOUT_TEXT\n')
elif mode == 'wrongevent':
    out({'hookSpecificOutput': {'hookEventName': 'Bogus', 'permissionDecision': 'deny'}})
elif mode == 'approve':
    out({'decision': 'approve'})
elif mode == 'contfalse':
    out({'continue': False, 'stopReason': 'ZN_TEST_CONTINUE_FALSE'})
elif mode == 'permallow':
    out(hso(decision={'behavior': 'allow'}))
elif mode == 'permdeny':
    out(hso(decision={'behavior': 'deny', 'message': 'ZN_TEST_PERM_DENY_MSG'}))
elif mode == 'ctx':
    out(hso(additionalContext='ZN_TEST_ADDITIONAL_CONTEXT'))
elif mode == 'sleep':
    time.sleep(8)
elif mode == 'update':
    out(hso(permissionDecision='allow', updatedInput={'command': 'echo ZN_TEST_REWRITTEN > /work/proj/REWRITTEN_MARK'}))
sys.exit(0)
