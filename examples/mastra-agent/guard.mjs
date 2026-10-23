// Wraps Mastra tools with zn-gate:
//   1. the tool call is checked before the tool runs;
//   2. the tool output is scrubbed before the model reads it.
// zn-gate runs locally here: no network call, no account.
import { createTool } from '@mastra/core/tools';
import znRules from 'zn-gate/lib/rules.js';

const { evaluate, sanitizeToolResult } = znRules;

export function guardTool(id, definition) {
  return createTool({
    id,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (input, context) => {
      // Check the call. A blocked call never reaches your code.
      const call = evaluate(`${id} ${JSON.stringify(input)}`);
      if (call.verdict === 'block') {
        return `zn-gate blocked the call to '${id}'. Reason: ${call.reason} (rule: ${call.rule}). Next step: do not retry; ask the person who runs this agent.`;
      }

      const result = await definition.execute(input, context);

      // Scrub the output. An injected instruction is replaced by a notice and secrets are hidden.
      const checked = sanitizeToolResult(id, result);
      return checked.sanitized_content;
    },
  });
}
