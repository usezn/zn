#!/usr/bin/env python3
"""Fake OpenAI chat-completions server (FICTITIOUS, local only). Scripted tool calls.
usage: fake_provider.py --port 18080 --scenario scenario.json --log provider.jsonl
scenario: {"steps":[{"tool":"bash","values":{"command":"echo hi"}}],"final":"done"}
 step i is used when i tool results exist after the last user message. Tool name = case-insensitive
 match of the "tool" hint against the tools declared in the request (exact first, then substring).
 Args = values[prop] for each property of the tool schema that appears in values; required props not
 in values get a type default."""
import json, time, argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=18080)
ap.add_argument('--scenario', required=True)
ap.add_argument('--log', required=True)
A = ap.parse_args()


def log(o):
    with open(A.log, 'a') as f:
        f.write(json.dumps(o, ensure_ascii=False) + '\n')


def tname(t):
    return (t.get('function') or t).get('name')


def tschema(t):
    f = t.get('function') or t
    return f.get('parameters') or f.get('input_schema') or {}


def pick(tools, hint):
    for t in tools:
        if tname(t).lower() == hint.lower():
            return t
    for t in tools:
        if hint.lower() in tname(t).lower():
            return t
    return None


def default(ty):
    return {'string': 'x', 'integer': 1, 'number': 1, 'boolean': True, 'array': [], 'object': {}}.get(ty if isinstance(ty, str) else 'string', 'x')


def build_args(t, values):
    sch = tschema(t)
    props = sch.get('properties', {})
    req = sch.get('required', [])
    out = {k: values[k] for k in props if k in values}
    for k in req:
        if k not in out:
            out[k] = default(props.get(k, {}).get('type', 'string'))
    return out


def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ''.join(p.get('text', '') if isinstance(p, dict) else str(p) for p in c)
    return str(c)


class H(BaseHTTPRequestHandler):
    tools_logged = False

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'object': 'list', 'data': [{'id': 'fake-model', 'object': 'model'}]}).encode())

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        sc = json.load(open(A.scenario))
        msgs = body.get('messages', [])
        tools = body.get('tools', [])
        last_user = max([i for i, m in enumerate(msgs) if m.get('role') == 'user'] or [-1])
        after = msgs[last_user + 1:]
        seq = sum(1 for m in after if m.get('role') == 'tool')
        steps = sc.get('steps', [])
        log({'t': time.time(), 'path': self.path, 'stream': body.get('stream'), 'seq': seq,
             'tool_names': [tname(t) for t in tools],
             'tools': [{'name': tname(t), 'schema': tschema(t)} for t in tools] if not H.tools_logged else '(logged)',
             'roles': [m.get('role') for m in msgs],
             'last_user': text_of(msgs[last_user].get('content', ''))[:3000] if last_user >= 0 else None,
             'tail': [{'role': m.get('role'), 'content': text_of(m.get('content', ''))[:3000]} for m in msgs[-4:]]})
        H.tools_logged = True
        call = None
        avail = []
        for st in steps:
            t = pick(tools, st['tool'])
            if t is None:
                if seq == 0:
                    log({'error': 'no tool matching (step skipped)', 'hint': st['tool']})
            else:
                avail.append((st, t))
        if seq < len(avail):
            st, t = avail[seq]
            call = (tname(t), json.dumps(build_args(t, st.get('values', {}))))
        cid = 'chatcmpl-fake-%d' % int(time.time() * 1000)
        if body.get('stream'):
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.end_headers()

            def ev(delta, fin=None):
                o = {'id': cid, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'fake-model',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': fin}]}
                self.wfile.write(('data: ' + json.dumps(o) + '\n\n').encode())
                self.wfile.flush()
            if call:
                ev({'role': 'assistant', 'content': None, 'tool_calls': [{'index': 0, 'id': 'call_fake_%d' % seq, 'type': 'function', 'function': {'name': call[0], 'arguments': ''}}]})
                ev({'tool_calls': [{'index': 0, 'function': {'arguments': call[1]}}]})
                ev({}, 'tool_calls')
            else:
                ev({'role': 'assistant', 'content': sc.get('final', 'done')})
                ev({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        else:
            msg = {'role': 'assistant', 'content': None if call else sc.get('final', 'done')}
            if call:
                msg['tool_calls'] = [{'id': 'call_fake_%d' % seq, 'type': 'function', 'function': {'name': call[0], 'arguments': call[1]}}]
            out = {'id': cid, 'object': 'chat.completion', 'created': int(time.time()), 'model': 'fake-model',
                   'choices': [{'index': 0, 'message': msg, 'finish_reason': 'tool_calls' if call else 'stop'}],
                   'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)


ThreadingHTTPServer(('127.0.0.1', A.port), H).serve_forever()
