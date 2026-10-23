'use strict';
/**
 * A post-tool event of each agent that can take a replacement of the tool output, and where that agent
 * takes the replacement from. Shared by the post-tool tests (invisible text, limits).
 */

const AGENTS = {
  'claude-code': {
    event: (text) => ({ session_id: 's', cwd: '/', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat f' }, tool_response: { stdout: text, stderr: '', interrupted: false } }),
    seen: (out) => out.hookSpecificOutput.updatedToolOutput.stdout,
    shapeKept: (out) => out.hookSpecificOutput.updatedToolOutput.interrupted === false && out.hookSpecificOutput.updatedToolOutput.stderr === '',
  },
  codex: {
    event: (text) => ({ session_id: 's', transcript_path: '/t', cwd: '/', hook_event_name: 'PostToolUse', model: 'm', turn_id: 't1', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'cat f' }, tool_response: text }),
    seen: (out) => out.reason,
    shapeKept: (out) => out.decision === 'block',
  },
  copilot: {
    event: (text) => ({ sessionId: 's', timestamp: 1792400000000, cwd: '/', toolName: 'bash', toolArgs: { command: 'cat f' }, toolResult: { resultType: 'success', textResultForLlm: text } }),
    seen: (out) => out.modifiedResult.textResultForLlm,
    shapeKept: (out) => out.modifiedResult.resultType === 'success',
  },
  opencode: {
    event: (text) => ({ hook: 'tool.execute.after', tool: 'bash', cwd: '/', args: {}, output: text, metadata: { preview: text } }),
    seen: (out) => out.output,
    shapeKept: (out) => out.action === 'output' && typeof out.metadata.preview === 'string',
  },
  cursor: {
    event: (text) => ({ hook_event_name: 'postToolUse', cwd: '/', tool_name: 'MCP:get_file', tool_input: {}, tool_output: JSON.stringify({ content: [{ type: 'text', text }] }) }),
    seen: (out) => out.updated_mcp_tool_output.content[0].text,
    shapeKept: (out) => out.updated_mcp_tool_output.content[0].type === 'text',
  },
};

module.exports = { AGENTS };
