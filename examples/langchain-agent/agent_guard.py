"""
Example: zn-gate with LangChain / LangGraph.

Two pieces:
- guard_langchain_tool(tool) wraps a tool: zn-gate checks the arguments before
  the tool runs, checks what the tool returns, and hides secrets in it before
  the model reads it.
- ZnGuardCallbackHandler stops the whole run (raises GuardBlockError) when a
  prompt, a tool call or a tool output is blocked. A callback cannot change a
  tool output, so it stops the run on a secret instead of hiding it.

The tool part needs langchain-core: pip install zn-gate langchain-core
The note below is made up; there is no network call and no model call.
"""
from zn_gate.integrations import ZnGuardCallbackHandler, guard_langchain_tool

# Pass callbacks=[handler] to your agent, chain or model run.
handler = ZnGuardCallbackHandler(on_block="raise")

try:
    from langchain_core.tools import tool
except ImportError:
    print("Install langchain-core to wrap tools: pip install langchain-core")
else:
    @tool
    def read_notes(topic: str) -> str:
        """Read the team notes on a topic."""
        return "Deploy settings: region=eu-west-1 key=AKIAIOSFODNN7EXAMPLE"

    # Give the agent safe_read_notes instead of read_notes.
    safe_read_notes = guard_langchain_tool(read_notes, on_block="return")
    print(safe_read_notes.invoke({"topic": "deploy"}))
    # Deploy settings: region=eu-west-1 key=[REDACTED_AWS_KEY]
    print(safe_read_notes.invoke({"topic": "cat ~/.ssh/id_rsa"}))
    # zn-gate blocked 'langchain:read_notes'. ...
