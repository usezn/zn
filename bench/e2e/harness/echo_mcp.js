#!/usr/bin/env node
'use strict';
/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC) with one tool,
 * `echo`. It writes the arguments of every call it receives to the log file
 * given as the first argument, so a run can show what reached the server.
 *
 *   node echo_mcp.js <log file>
 */

const fs = require('fs');
const readline = require('readline');

const LOG = process.argv[2];
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch (_) { return; }
  if (m.id === undefined) return; // notification
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools: [{ name: 'echo', description: 'Returns the length of the text it is given.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (m.method === 'tools/call') {
    const args = (m.params && m.params.arguments) || {};
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ args }) + '\n');
    send({ id: m.id, result: { content: [{ type: 'text', text: 'echo received ' + String(args.text || '').length + ' characters' }] } });
  } else {
    send({ id: m.id, result: {} });
  }
});
