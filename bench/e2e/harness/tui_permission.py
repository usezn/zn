#!/usr/bin/env python3
"""Drives the Codex terminal UI through a pseudo-terminal for the PermissionRequest
scenario (`codex exec` never asks for approval, so the hook cannot run there).

The scripted provider asks for two commands that need an approval. This driver
plays the user: it never approves. When an approval prompt is shown it presses
Esc (decline, which also interrupts the turn), and it writes what the screen
showed to <out>/tui.txt.

  python3 tui_permission.py <codex binary> <project dir> <out dir> [extra codex args ...]

Exit code 0 when the session reached the end of the script, 1 on a timeout.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

codex, proj, out = sys.argv[1:4]
extra = sys.argv[4:]
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]')
PROMPT = re.compile(r'(Yes, proceed|Would you like to run|approve|Allow command)', re.I)
DEADLINE = time.time() + float(os.environ.get('TUI_TIMEOUT', '90'))


def requests_with_tools():
    try:
        n = 0
        for line in open(os.path.join(out, 'requests.jsonl')):
            if '"tools":[{' in line:
                n += 1
        return n
    except OSError:
        return 0


pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.execvp(codex, [codex, '--no-alt-screen', '--no-daemon', '--dangerously-bypass-hook-trust',
                      '-c', 'approval_policy="on-request"', '-s', 'read-only'] + extra + ['Follow the setup task.'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 140, 0, 0))
screen = ''
fresh = ''
declined = 0
last_decline = 0.0
finished_at = None
log = open(os.path.join(out, 'tui_raw.txt'), 'wb')
try:
    while time.time() < DEADLINE:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            log.write(data)
            text = ANSI.sub('', data.decode('utf-8', 'replace'))
            screen += text
            fresh += text
            # Answer terminal queries that the UI waits for (cursor position, device attributes).
            if b'\x1b[6n' in data:
                os.write(fd, b'\x1b[1;1R')
            if b'\x1b[c' in data or b'\x1b[0c' in data:
                os.write(fd, b'\x1b[?62;c')
        if PROMPT.search(fresh) and time.time() - last_decline > 3:
            time.sleep(0.5)
            os.write(fd, b'\x1b')  # Esc: "No" (the turn is interrupted)
            declined += 1
            last_decline = time.time()
            fresh = ''
            screen += '\n[driver: pressed Esc on an approval prompt]\n'
        # Esc on an approval prompt declines it and interrupts the turn, so the script ends there.
        if declined and time.time() - last_decline > 4 and finished_at is None:
            finished_at = time.time()
        if finished_at and time.time() - finished_at > 4:
            break
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    open(os.path.join(out, 'tui.txt'), 'w').write(screen)
    open(os.path.join(out, 'tui_declined.txt'), 'w').write(str(declined) + '\n')
sys.exit(0 if finished_at else 1)
