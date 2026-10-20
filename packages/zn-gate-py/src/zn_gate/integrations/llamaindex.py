"""
LlamaIndex query and tool protection for zn-gate.

`on_block` modes of ZnLlamaGuard:
- "raise" (default): a blocked query raises GuardBlockError.
- "ignore": log only. The finding is logged as a warning on the "zn_gate" logger
  and the query is returned unchanged.
- "return" is not supported (check_query returns the query itself, so there is
  nothing safe to return in its place) and raises ValueError.
"""
from __future__ import annotations
import logging
from typing import Any, Optional

from ..guard import GuardBlockError, validate_on_block
from ..rules import evaluate, sanitize_tool_result
from .langchain import reject_return_mode


ON_BLOCK_MODES = ("raise", "ignore")

_log = logging.getLogger("zn_gate")


class ZnLlamaGuard:
    """
    Query pre-check and response redaction for LlamaIndex query engines and agents.

    - `check_query` / `on_query_start` raise GuardBlockError on a blocked query
      ("raise") or only log it ("ignore").
    - `sanitize_response` redacts secrets in a response you pass to it; it is a
      plain method, so it works wherever you call it. `mask_secrets=False` turns it off.
    """
    def __init__(self, on_block: str = "raise", mask_secrets: bool = True, raise_on_violation: Optional[bool] = None):
        reject_return_mode(on_block, "ZnLlamaGuard",
                           "to replace a blocked input, catch GuardBlockError around check_query.")
        on_block = validate_on_block(on_block, ON_BLOCK_MODES)
        if raise_on_violation is not None:
            self.on_block = "raise" if raise_on_violation else "ignore"
        else:
            self.on_block = on_block
        self.mask_secrets = mask_secrets

    def check_query(self, query_str: str) -> str:
        assessment = evaluate(query_str)
        if not assessment.allowed:
            if self.on_block == "raise":
                raise GuardBlockError(assessment, target="llamaindex:query", payload=query_str)
            _log.warning("zn-gate (on_block='ignore', not blocked): llamaindex:query matched rule %s", assessment.rule)
        return query_str

    def on_query_start(self, query_str: str) -> str:
        return self.check_query(query_str)

    def sanitize_response(self, response: Any) -> Any:
        if self.mask_secrets:
            clean, _ = sanitize_tool_result(response)
            return clean
        return response
