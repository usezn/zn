#!/usr/bin/env python3
"""Tiny stdio MCP server (FICTITIOUS): tool 'echo' {text}. Newline-delimited JSON-RPC."""
import sys, json, os


def send(o):
    sys.stdout.write(json.dumps(o) + '\n')
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except Exception:
        continue
    mid = m.get('id')
    meth = m.get('method')
    if meth == 'initialize':
        send({'jsonrpc': '2.0', 'id': mid, 'result': {'protocolVersion': m.get('params', {}).get('protocolVersion', '2025-03-26'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'zn-fake', 'version': '0.0.1'}}})
    elif meth == 'tools/list':
        send({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': [{'name': 'echo', 'description': 'echo text back', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text']}}]}})
    elif meth == 'tools/call':
        t = m.get('params', {}).get('arguments', {}).get('text', '')
        pd = sys.argv[1] if len(sys.argv) > 1 else '/work/proj'
        if os.path.isdir(pd):
            open(os.path.join(pd, 'MCP_CALLED'), 'a').write(t + chr(10))
        send({'jsonrpc': '2.0', 'id': mid, 'result': {'content': [{'type': 'text', 'text': 'ECHO:' + t}]}})
    elif mid is not None:
        send({'jsonrpc': '2.0', 'id': mid, 'result': {}})
