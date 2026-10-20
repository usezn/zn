// LangChain.js / LangGraph.js with zn-gate: block a dangerous tool call and scrub the tool output.
// Runs offline: a scripted chat model stands in for a real LLM, so no API key is needed.
const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage, ToolMessage } = require('@langchain/core/messages');
const { StateGraph, MessagesAnnotation, START, END } = require('@langchain/langgraph');
const { evaluate, sanitizeToolResult } = require('zn-gate/lib/rules');

// --- zn-gate wrapper: works around any LangChain tool ---------------------------------------------
// 1. Inspect the call (tool name + arguments) before it runs; refuse it when zn-gate says block.
// 2. Scrub what the tool returns before the model sees it (secrets masked, injections removed).
function guardTool(inner) {
  return tool(
    async (args) => {
      const verdict = evaluate(`${inner.name} ${JSON.stringify(args)}`);
      if (verdict.verdict === 'block') {
        console.log(`[zn-gate] BLOCKED ${inner.name}(${JSON.stringify(args)}) rule=${verdict.rule}`);
        return `Blocked by zn-gate (${verdict.rule}). The tool was not run.`;
      }
      const result = await inner.invoke(args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      const clean = sanitizeToolResult(inner.name, text);
      console.log(
        `[zn-gate] ${inner.name} output: safe_to_ingest=${clean.safe_to_ingest} secrets_redacted=${clean.secrets_redacted}`
      );
      return clean.sanitized_content;
    },
    { name: inner.name, description: inner.description, schema: inner.schema }
  );
}

// --- Two fictitious tools ----------------------------------------------------------------------
const runShell = tool(async ({ command }) => `ran: ${command}`, {
  name: 'run_shell',
  description: 'Run a shell command.',
  schema: z.object({ command: z.string() }),
});
const readConfig = tool(
  async () => 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\ndb=postgres://app:hunter2@db.example.com:5432/main',
  { name: 'read_config', description: 'Read the app config.', schema: z.object({}) }
);
const tools = [runShell, readConfig].map(guardTool);

// --- Scripted model: first asks for two tool calls, then answers from what it saw -----------------
class ScriptedModel extends BaseChatModel {
  _llmType() {
    return 'scripted';
  }
  async _generate(messages) {
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('Done. Tool output seen by the model:\n' + messages.filter((m) => ToolMessage.isInstance(m)).map((m) => m.content).join('\n'))
      : new AIMessage({
          content: '',
          tool_calls: [
            { id: 'call_1', name: 'run_shell', args: { command: 'cat ~/.ssh/id_rsa' } },
            { id: 'call_2', name: 'read_config', args: {} },
          ],
        });
    return { generations: [{ text: String(message.content), message }] };
  }
}

// --- LangGraph agent loop: model -> tools -> model --------------------------------------------------
const model = new ScriptedModel({});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const graph = new StateGraph(MessagesAnnotation)
  .addNode('model', async (state) => ({ messages: [await model.invoke(state.messages)] }))
  .addNode('tools', async (state) => {
    const calls = state.messages[state.messages.length - 1].tool_calls;
    const out = [];
    for (const c of calls) {
      out.push(new ToolMessage({ tool_call_id: c.id, name: c.name, content: await byName[c.name].invoke(c.args) }));
    }
    return { messages: out };
  })
  .addEdge(START, 'model')
  .addConditionalEdges('model', (s) => (s.messages[s.messages.length - 1].tool_calls?.length ? 'tools' : END))
  .addEdge('tools', 'model')
  .compile();

(async () => {
  const result = await graph.invoke({ messages: [['human', 'Show me the deploy config.']] });
  const final = result.messages[result.messages.length - 1].content;
  console.log('\n' + final);
  const ok = final.includes('Blocked by zn-gate') && final.includes('[REDACTED_AWS_KEY]') && !final.includes('AKIAIOSFODNN7EXAMPLE') && !final.includes('hunter2');
  console.log(ok ? '\nzn-gate demo OK: dangerous call blocked, secrets scrubbed' : '\nzn-gate demo FAILED');
  process.exit(ok ? 0 : 1);
})();
