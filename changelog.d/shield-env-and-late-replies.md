### Security
- `zn-gate shield` no longer passes zn-gate's own secrets (`ZN_*` variables with KEY, TOKEN, SECRET or PASS in the name) to the wrapped MCP server. The AI agents' credentials (for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) are passed only when named in `ZN_SHIELD_PASS_ENV`, and the shield names any it left out.
- A reply that arrives after more than 5,000 other calls were waiting can no longer be checked, so the shield now refuses it instead of forwarding it unchecked.
