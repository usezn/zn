"""
Example: Integrating zn-gate with LangChain / LangGraph.
Zero external dependencies required by zn-gate.
"""
from zn_gate.integrations import ZnGuardCallbackHandler

# Attach handler to any LangChain agent, chain, or LLM call
# A callback handler stops a run; LangChain ignores what callbacks return, so it
# cannot redact secrets. To redact a tool result, wrap the tool with
# zn_gate.integrations.guarded_tool(...) or call sanitize_tool_result inside it.
handler = ZnGuardCallbackHandler(
    on_block="raise",     # Raise GuardBlockError on injection attempts ("ignore" only logs)
)

print("ZnGuardCallbackHandler initialized and ready for LangChain agent loops.")
