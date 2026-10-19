// Wraps Vercel AI SDK tools with zn-gate:
//   1. the tool call is checked before the tool runs;
//   2. the tool output is scrubbed before the model reads it.
// zn-gate runs locally here: no network call, no account.
import { tool } from 'ai';
import znRules from 'zn-gate/lib/rules.js';

const { evaluate, sanitizeToolResult } = znRules;

export function guardTool(name, definition) {
  return tool({
    ...definition,
    execute: async (input, options) => {
      // Check the call. A blocked call never reaches your code.
      const call = evaluate(`${name} ${JSON.stringify(input)}`);
      if (call.verdict === 'block') {
        return `zn-gate blocked the call to '${name}'. Reason: ${call.reason} (rule: ${call.rule}). Next step: do not retry; ask the person who runs this agent.`;
      }

      const result = await definition.execute(input, options);

      // Scrub the output. An injected instruction is replaced by a notice and secrets are hidden.
      const checked = sanitizeToolResult(name, result);
      return checked.sanitized_content;
    },
  });
}
