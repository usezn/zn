'use strict';

const readline = require('readline');
const { analyze, analyzeLocal, checkToolResult, isCloudEnabled, RULES_VERSION, resolveEndpoint } = require('./client');
const { sanitizeToolResult } = require('./rules');

const SERVER_NAME = 'zn-gate';
let SERVER_VERSION = '1.4.1';
try {
  SERVER_VERSION = require('../package.json').version || '1.4.1';
} catch (_) {}

// MCP versions this server speaks (initialize era). A client asking for one
// of them gets it; any other request gets the latest. The 2026-07-28 era
// (server/discover, no initialize) is not implemented: server/discover
// answers -32601, which tells such a client to fall back to initialize.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

const LOCAL_RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'analyze_prompt',
    title: 'Analyze a prompt',
    description: 'Analyze text, prompt, or agent messages for security threats (prompt injection, jailbreak, credential exfiltration, role hijacking). Runs locally; only if the user set ZN_CLOUD=1 and ZN_API_KEY is the text, with secrets redacted, also sent to the zn cloud gate. Returns threat assessment, confidence score, and matched rule.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The user input, system prompt, or external message to inspect.',
        },
      },
      required: ['text'],
    },
    annotations: LOCAL_RO,
  },
  {
    name: 'check_tool_call',
    title: 'Check a tool call',
    description: 'Pre-flight safety inspection for tool invocations and arguments before execution. Always local: arguments never leave the machine. Defends against tool poisoning, argument injection, and unauthorized exfiltration attempts.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'The name of the tool to be called (e.g. bash, write_file, execute_sql, send_message).',
        },
        arguments: {
          type: 'object',
          description: 'Parameters/payload object that will be supplied to the tool.',
        },
      },
      required: ['tool_name', 'arguments'],
    },
    annotations: LOCAL_RO,
  },
  {
    name: 'check_tool_result',
    title: 'Check a tool result',
    description: 'Post-execution safety inspection for tool outputs and third-party content (web pages, git commits, database queries) before LLM context assimilation. Always local: content never leaves the machine. Returns the content with secrets redacted, or neutralized if an injection is detected.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'The name of the tool that produced the output (e.g. fetch, web_search, read_file).',
        },
        content: {
          type: 'string',
          description: 'The output text, markdown, or JSON payload returned by the tool.',
        },
      },
      required: ['tool_name', 'content'],
    },
    annotations: LOCAL_RO,
  },
  {
    name: 'zn_status',
    title: 'zn-gate status',
    description: 'Get current zn-gate status: engine, rules version, and exactly what (if anything) leaves the machine.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: LOCAL_RO,
  },
];

const ELICITATION_TIMEOUT_MS = 120000;

/**
 * One MCP session over a line-oriented transport.
 *
 * createMcpServer(options, io)
 *   options   CLI options (apiKey, localOnly, ...)
 *   io.write(message)   sends one JSON-RPC message (default: a line on stdout)
 *   io.env              environment (default process.env)
 *   io.team             zn Team admin tools (default: lib/team/admin/tools)
 *   io.teamOptions      extra options for the default team tools (tests)
 *
 * handleMessage(message) -> Promise<response | null>. Responses from the
 * client to requests this server sent (elicitation/create) resolve those
 * requests and return null.
 */
function createMcpServer(options = {}, io = {}) {
  const write = io.write || ((msg) => process.stdout.write(JSON.stringify(msg) + '\n'));
  const env = io.env || process.env;
  const session = { protocolVersion: null, clientCapabilities: {}, clientInfo: null };
  const pending = new Map();
  let nextId = 0;

  function elicitationSupported() {
    const e = session.clientCapabilities && session.clientCapabilities.elicitation;
    if (!e || typeof e !== 'object') return false;
    // {} means form mode (2025-06-18); later clients list the modes they support.
    const keys = Object.keys(e);
    return keys.length === 0 || Object.prototype.hasOwnProperty.call(e, 'form');
  }

  /** Send a request to the client; resolves with its result. */
  function sendRequest(method, params, timeoutMs) {
    const id = 'zn-' + (++nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timed out' } });
        const err = new Error(method + ' timed out');
        err.code = 'ZN_TIMEOUT';
        reject(err);
      }, timeoutMs || ELICITATION_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  function handleResponse(message) {
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) {
      const err = new Error(String(message.error.message || 'client error'));
      err.code = 'ZN_CLIENT_ERROR';
      err.rpc = message.error;
      p.reject(err);
    } else {
      p.resolve(message.result);
    }
  }

  const team = io.team || require('./team/admin/tools').createTeamAdmin(Object.assign({
    env,
    localOnly: options.localOnly,
    version: SERVER_VERSION,
    session: () => ({ protocolVersion: session.protocolVersion, clientInfo: session.clientInfo, elicitation: elicitationSupported() }),
    elicit: (params, timeoutMs) => sendRequest('elicitation/create', params, timeoutMs),
  }, io.teamOptions || {}));

  function result(id, value) {
    return { jsonrpc: '2.0', id, result: value };
  }

  function error(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  }

  async function callLocalTool(toolName, args) {
    if (toolName === 'analyze_prompt') {
      const text = typeof args.text === 'string' ? args.text : '';
      const assessment = await analyze(text, options);
      const isBlock = assessment.verdict?.toLowerCase() === 'block';
      return { isError: isBlock, content: [{ type: 'text', text: JSON.stringify(assessment, null, 2) }] };
    }

    if (toolName === 'check_tool_call') {
      const targetTool = String(args.tool_name || 'unknown');
      const toolArgs = args.arguments || {};

      const stringValues = [];
      function extractStrings(obj) {
        if (typeof obj === 'string') stringValues.push(obj);
        else if (Array.isArray(obj)) obj.forEach(extractStrings);
        else if (obj && typeof obj === 'object') Object.values(obj).forEach(extractStrings);
      }
      extractStrings(toolArgs);

      // Local only: tool-call arguments never leave the machine.
      let worstAssessment = analyzeLocal(`${targetTool}: ${JSON.stringify(toolArgs)}`, options);
      let isBlock = worstAssessment.verdict?.toLowerCase() === 'block';

      if (!isBlock) {
        for (const str of stringValues) {
          if (str.length >= 4) {
            const subRes = analyzeLocal(str, options);
            if (subRes.verdict?.toLowerCase() === 'block') {
              worstAssessment = subRes;
              isBlock = true;
              break;
            }
          }
        }
      }

      const { sanitized: sanitizedArgs, detections } = sanitizeToolResult(toolArgs);
      const output = {
        tool_name: targetTool,
        safe_to_execute: !isBlock,
        assessment: worstAssessment,
        secrets_redacted: detections.length,
        sanitized_arguments: sanitizedArgs,
      };
      return { isError: isBlock, content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'check_tool_result') {
      const targetTool = String(args.tool_name || 'unknown');
      const rawContent = args.content !== undefined ? (typeof args.content === 'string' ? args.content : JSON.stringify(args.content)) : '';
      const output = await checkToolResult(targetTool, rawContent, options);
      return { isError: !output.safe_to_ingest, content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'zn_status') {
      const cloud = isCloudEnabled(options);
      const status = {
        package: `${SERVER_NAME}@${SERVER_VERSION}`,
        engine: cloud ? 'local-rules + cloud (analyze_prompt only)' : 'local-rules',
        endpoint: cloud ? resolveEndpoint(options) : 'none (local only)',
        rules_version: RULES_VERSION,
        cloud_enabled: cloud,
        leaves_machine: cloud
          ? 'analyze_prompt text only, with secrets redacted locally before sending. Tool results and tool-call arguments never leave the machine.'
          : 'nothing',
        lifecycle_coverage: 'bidirectional (prompt, pre-tool-call, post-tool-result)',
      };
      let teamStatus = null;
      try { teamStatus = team.status(); } catch (_) { teamStatus = null; }
      if (teamStatus) status.team = teamStatus;
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    return null;
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object') return error(null, -32600, 'Invalid request');
    const { id, method, params } = message;

    // A response to a request this server sent.
    if (method === undefined && id !== undefined && ('result' in message || 'error' in message)) {
      handleResponse(message);
      return null;
    }

    switch (method) {
      case 'initialize': {
        const p = params || {};
        session.protocolVersion = negotiateProtocolVersion(p.protocolVersion);
        session.clientCapabilities = p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {};
        session.clientInfo = p.clientInfo && typeof p.clientInfo === 'object'
          ? { name: String(p.clientInfo.name || ''), version: String(p.clientInfo.version || '') }
          : null;
        return result(id, {
          protocolVersion: session.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return result(id, {});

      case 'tools/list': {
        let teamTools = [];
        try { teamTools = await team.listTools(); } catch (_) { teamTools = []; }
        return result(id, { tools: TOOLS.concat(teamTools) });
      }

      case 'tools/call': {
        if (!params || typeof params.name !== 'string') {
          return error(id, -32602, 'Invalid params: name is required');
        }
        const toolName = params.name;
        const args = params.arguments || {};
        const local = await callLocalTool(toolName, args);
        if (local) return result(id, local);
        const teamResult = await team.callTool(toolName, args);
        if (teamResult) return result(id, teamResult);
        return error(id, -32601, `Method or tool '${toolName}' not found`);
      }

      default: {
        if (id !== undefined) {
          return error(id, -32601, `Unsupported method: ${method}`);
        }
        return null;
      }
    }
  }

  function close() {
    for (const [key, p] of pending) {
      clearTimeout(p.timer);
      const err = new Error('session closed');
      err.code = 'ZN_CLIENT_ERROR';
      p.reject(err);
      pending.delete(key);
    }
  }

  return { handleMessage, sendRequest, session, team, close, elicitationSupported };
}

let defaultServer = null;

/** Handle one message and write the response to stdout (kept for callers of the 1.x API). */
async function handleRequest(message, options) {
  if (!defaultServer) defaultServer = createMcpServer(options);
  const res = await defaultServer.handleMessage(message);
  if (res) process.stdout.write(JSON.stringify(res) + '\n');
}

function startMcpServer(options = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const server = createMcpServer(options, { write });

  if (process.env.DEBUG || process.env.ZN_VERBOSE) {
    process.stderr.write(`[zn-gate] MCP server listening on stdio (engine: ${isCloudEnabled(options) ? 'local + cloud for analyze_prompt' : 'local only'})...\n`);
  }

  // Lines are handled concurrently: a tools/call waiting for the client's
  // answer to elicitation/create must not block reading that answer.
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      if (process.env.DEBUG) {
        process.stderr.write(`[zn-gate] JSON-RPC parse error: ${err.message}\n`);
      }
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: err.message } });
      return;
    }
    try {
      const res = await server.handleMessage(message);
      if (res) write(res);
    } catch (err) {
      if (message && message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } });
      }
    }
  });

  rl.on('close', () => {
    server.close();
    process.exit(0);
  });
  return server;
}

module.exports = {
  startMcpServer,
  createMcpServer,
  handleRequest,
  negotiateProtocolVersion,
  TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
};
