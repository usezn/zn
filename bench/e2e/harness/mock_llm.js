#!/usr/bin/env node
'use strict';
/**
 * Scripted model provider for end-to-end runs. It speaks just enough of
 * four wire APIs for real agents to run against it on 127.0.0.1:
 *
 *   POST /v1/messages           Anthropic Messages (Claude Code), SSE or JSON
 *   POST /v1/responses          OpenAI Responses (Codex), SSE
 *   POST /v1/chat/completions   OpenAI Chat Completions (OpenCode), SSE
 *   POST /v1beta/models/<m>:streamGenerateContent | :generateContent | :countTokens   Gemini API (Gemini CLI)
 *
 * Every request body is appended to <out>/requests.jsonl: that file is
 * exactly what the agent sent to "the provider", and the leak check greps it.
 *
 * The script is a JSON file: {"steps": [{"tool": "<name>", "input": {...}}, ...], "final": "text"}.
 * A step may add "namespace" (Responses API: how Codex names the tools of an MCP server).
 * The step to play is the number of tool results already in the request, so
 * side requests (titles, summaries) do not advance it. Requests without
 * tools get a short text answer. Instead of "final", a script may give
 * "finals": the text of the first answer, of the second one (after the agent
 * continued because a Stop hook asked it to), and so on (Responses API only).
 *
 *   node mock_llm.js --port 8787 --script scenario.json --out dir
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PORT = Number(arg('--port', 8787));
const OUT = path.resolve(arg('--out', '.'));
const SCRIPT = JSON.parse(fs.readFileSync(arg('--script'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'requests.jsonl');

let seq = 0;
const id = (p) => p + '_' + (++seq).toString(36) + Date.now().toString(36);

function record(req, body) {
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), method: req.method, url: req.url, body }) + '\n');
}

function stepFor(count) {
  return count < SCRIPT.steps.length ? SCRIPT.steps[count] : null;
}

/* ----------------------------- Anthropic ----------------------------- */

function anthropicToolResults(body) {
  let n = 0;
  for (const m of body.messages || []) {
    if (m.role === 'user' && Array.isArray(m.content)) n += m.content.filter((c) => c && c.type === 'tool_result').length;
  }
  return n;
}

function anthropic(body, res) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const step = hasTools ? stepFor(anthropicToolResults(body)) : null;
  const content = step
    ? [{ type: 'tool_use', id: id('toolu'), name: step.tool, input: step.input }]
    : [{ type: 'text', text: hasTools ? (SCRIPT.final || 'Done.') : 'ok' }];
  const stop = step ? 'tool_use' : 'end_turn';
  const message = { id: id('msg'), type: 'message', role: 'assistant', model: body.model || 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...message, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }));
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const ev = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
  ev('message_start', { message });
  content.forEach((c, index) => {
    if (c.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: c.text } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', {});
  res.end();
}

/* --------------------------- OpenAI Responses -------------------------- */

function responsesToolResults(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  return input.filter((i) => i && (i.type === 'function_call_output' || i.type === 'custom_tool_call_output' || i.type === 'local_shell_call_output')).length;
}

function finalText(body) {
  if (!Array.isArray(SCRIPT.finals) || !SCRIPT.finals.length) return SCRIPT.final || 'Done.';
  const input = Array.isArray(body.input) ? body.input : [];
  const earlier = input.filter((i) => i && i.type === 'message' && i.role === 'assistant').length;
  return SCRIPT.finals[Math.min(earlier, SCRIPT.finals.length - 1)];
}

function responses(body, res) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const step = hasTools ? stepFor(responsesToolResults(body)) : null;
  const respId = id('resp');
  let item;
  if (step) {
    item = step.custom
      ? { type: 'custom_tool_call', id: id('ctc'), call_id: id('call'), name: step.tool, input: step.input, status: 'completed' }
      : { type: 'function_call', id: id('fc'), call_id: id('call'), name: step.tool, ...(step.namespace ? { namespace: step.namespace } : {}), arguments: JSON.stringify(step.input), status: 'completed' };
  } else {
    item = { type: 'message', id: id('m'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: hasTools ? finalText(body) : 'ok', annotations: [] }] };
  }
  res.setHeader('content-type', 'text/event-stream');
  let n = 0;
  const ev = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: n++, ...data }) + '\n\n');
  const base = { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model || 'mock', status: 'in_progress', output: [] };
  ev('response.created', { response: base });
  ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
  ev('response.output_item.done', { output_index: 0, item });
  ev('response.completed', { response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } });
  res.end();
}

/* ------------------------ OpenAI Chat Completions ----------------------- */

function chatToolResults(body) {
  return (body.messages || []).filter((m) => m && m.role === 'tool').length;
}

function chat(body, res) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const step = hasTools ? stepFor(chatToolResults(body)) : null;
  const cid = id('chatcmpl');
  const chunk = (delta, finish) => res.write('data: ' + JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model || 'mock', choices: [{ index: 0, delta, finish_reason: finish || null }] }) + '\n\n');
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    const message = step
      ? { role: 'assistant', content: null, tool_calls: [{ id: id('call'), type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.input) } }] }
      : { role: 'assistant', content: hasTools ? (SCRIPT.final || 'Done.') : 'ok' };
    res.end(JSON.stringify({ id: cid, object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, message, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  chunk({ role: 'assistant', content: '' });
  if (step) {
    chunk({ tool_calls: [{ index: 0, id: id('call'), type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.input) } }] });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: hasTools ? (SCRIPT.final || 'Done.') : 'ok' });
    chunk({}, 'stop');
  }
  res.write('data: ' + JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* ------------------------------ Gemini API ------------------------------ */

function geminiToolResults(body) {
  let n = 0;
  for (const c of body.contents || []) {
    if (c && Array.isArray(c.parts)) n += c.parts.filter((p) => p && p.functionResponse).length;
  }
  return n;
}

function gemini(body, res, stream) {
  const hasTools = Array.isArray(body.tools) && body.tools.some((t) => t && Array.isArray(t.functionDeclarations) && t.functionDeclarations.length);
  const step = hasTools ? stepFor(geminiToolResults(body)) : null;
  const parts = step
    ? [{ functionCall: { name: step.tool, args: step.input } }]
    : [{ text: hasTools ? (SCRIPT.final || 'Done.') : 'ok' }];
  const resp = {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    modelVersion: 'mock-model',
  };
  if (stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: ' + JSON.stringify(resp) + '\r\n\r\n');
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(resp));
}

/* -------------------------------- server ------------------------------- */

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = { _raw: raw }; }
    record(req, body);
    const url = req.url.split('?')[0];
    try {
      if (req.method === 'POST' && /\/v1\/messages\/count_tokens$/.test(url)) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ input_tokens: 10 }));
      } else if (req.method === 'POST' && /\/v1\/messages$/.test(url)) anthropic(body, res);
      else if (req.method === 'POST' && /\/responses$/.test(url)) responses(body, res);
      else if (req.method === 'POST' && /:countTokens$/.test(url)) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ totalTokens: 10 }));
      } else if (req.method === 'POST' && /:streamGenerateContent$/.test(url)) gemini(body, res, true);
      else if (req.method === 'POST' && /:generateContent$/.test(url)) gemini(body, res, false);
      else if (req.method === 'POST' && /\/chat\/completions$/.test(url)) chat(body, res);
      else if (req.method === 'GET' && /\/models$/.test(url)) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err && err.message) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => process.stdout.write('mock llm on 127.0.0.1:' + PORT + '\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
