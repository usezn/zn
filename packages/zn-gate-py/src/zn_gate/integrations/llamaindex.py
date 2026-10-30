"""
LlamaIndex query and tool protection for zn-gate.

For LlamaIndex tools, wrap the function with `guarded_tool` before
`FunctionTool.from_defaults(fn=...)`: the arguments are checked before the
function runs and the output is checked and masked before the agent reads it.
"""
from __future__ import annotations
import copy
from typing import Any, Optional

from ..guard import GuardBlockError, block_message, validate_on_block, warn_ignored
from ..rules import evaluate, sanitize_tool_result


ON_BLOCK_MODES = ("raise", "return", "ignore")


class ZnLlamaGuard:
    """
    Query check and response masking for LlamaIndex query engines and agents.

    Parameters:
    - on_block: "raise" (default) raises GuardBlockError for a blocked query;
                "return" makes check_query / on_query_start return `fallback`, or
                the plain block message when fallback is None, in place of the
                query, so the engine never sees the blocked text; "ignore" lets
                the query through unchanged.
    - mask_secrets: Hide credentials in sanitize_response (default True).
    - fallback: Text returned for a blocked query when on_block="return".
    """
    def __init__(self, on_block: str = "raise", mask_secrets: bool = True,
                 raise_on_violation: Optional[bool] = None, fallback: Optional[str] = None):
        on_block = validate_on_block(on_block, ON_BLOCK_MODES)
        if raise_on_violation is not None:
            self.on_block = "raise" if raise_on_violation else "ignore"
        else:
            self.on_block = on_block
        self.mask_secrets = mask_secrets
        self.fallback = fallback

    def check_query(self, query_str: str) -> str:
        assessment = evaluate(query_str)
        if not assessment.allowed:
            if self.on_block == "raise":
                raise GuardBlockError(assessment, target="llamaindex:query", payload=query_str)
            if self.on_block == "return":
                if self.fallback is not None:
                    return self.fallback
                return block_message(assessment, "llamaindex:query")
            warn_ignored(assessment, "llamaindex:query")
        return query_str

    def on_query_start(self, query_str: str) -> str:
        return self.check_query(query_str)

    def sanitize_response(self, response: Any) -> Any:
        """Hide credentials in a response.

        Accepts text, lists and dicts, and a LlamaIndex Response object (its
        `response` text is masked in a copy; the original is left as it was).
        A streaming response is not masked: read it to text first.
        """
        if not self.mask_secrets:
            return response
        text = getattr(response, "response", None)
        if isinstance(text, str) and not isinstance(response, (str, dict, list, tuple)):
            clean_text, found = sanitize_tool_result(text)
            if not found:
                return response
            clean_obj = copy.copy(response)
            clean_obj.response = clean_text
            return clean_obj
        clean, _ = sanitize_tool_result(response)
        return clean
