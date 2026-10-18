// Starts `zn-gate mcp` over stdio, the way an MCP directory checks a server, and asserts that it answers
// initialize and tools/list with exactly the expected tools. Fails if there is no answer within 30 s.
// No dependencies. Usage: node mcp-smoke.mjs [command [args...]]   (default: zn-gate mcp)
import { spawn } from 'node:child_process';

const EXPECTED_TOOLS = ['analyze_prompt', 'check_tool_call', 'check_tool_result', 'zn_status'];
const TIMEOUT_MS = 30_000;
// Protocol version sent in initialize. Set MCP_SMOKE_PROTOCOL to test another version (the workflow runs both).
const PROTOCOL = process.env.MCP_SMOKE_PROTOCOL || '2024-11-05';
const [cmd, ...args] = process.argv.length > 2 ? process.argv.slice(2) : ['zn-gate', 'mcp'];

const child = spawn(cmd, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ZN_LOCAL_ONLY: 'true' },
});

let finished = false;
function finish(code, msg) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  (code === 0 ? console.log : console.error)(msg);
  child.kill();
  process.exitCode = code;
}
const timer = setTimeout(() => finish(1, `FAIL: no complete answer within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);

child.on('error', (e) => finish(1, `FAIL: cannot start "${cmd}": ${e.message}`));
child.on('exit', (code) => finish(1, `FAIL: server exited early (code ${code})`));

child.stdin.on('error', () => {});
const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { return finish(1, `FAIL: non-JSON line on stdout: ${line.slice(0, 200)}`); }
    if (msg.error) return finish(1, `FAIL: error response: ${JSON.stringify(msg.error)}`);
    if (msg.id === 1) {
      const info = msg.result && msg.result.serverInfo;
      if (!info || info.name !== 'zn-gate' || !msg.result.protocolVersion) return finish(1, `FAIL: unexpected initialize result: ${line.slice(0, 300)}`);
      console.log(`initialize ok: ${info.name} ${info.version}, protocol ${msg.result.protocolVersion}`);
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      const names = ((msg.result && msg.result.tools) || []).map((t) => t.name).sort();
      const want = [...EXPECTED_TOOLS].sort();
      if (JSON.stringify(names) !== JSON.stringify(want)) return finish(1, `FAIL: tools ${JSON.stringify(names)} != expected ${JSON.stringify(want)}. If the change is intended, update EXPECTED_TOOLS and every public surface that lists the tools (README, MCP Registry, Glama, same release cycle).`);
      return finish(0, `PASS: tools/list returned ${names.length} tools: ${names.join(', ')}`);
    }
  }
});

send({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1.0.0' } },
});
