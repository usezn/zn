"""
LangChain and LangGraph integration for zn-gate.
Zero hard dependencies on langchain.

What a callback handler can and cannot do
-----------------------------------------
LangChain calls a handler for its side effects and ignores what the callbacks
return. So this handler can STOP a run (by raising GuardBlockError, which
langchain-core re-raises because `raise_error` is True) but it cannot REWRITE
anything: a tool result that holds a credential reaches the agent exactly as the
tool returned it. To redact secrets, wrap the tool itself with
`zn_gate.integrations.guarded_tool(...)` or call `zn_gate.sanitize_tool_result`
on the output inside the tool.

`on_block` modes:
- "raise" (default): a blocked prompt, tool input or tool output raises
  GuardBlockError and the run stops.
- "ignore": log only. The finding is logged as a warning on the "zn_gate"
  logger and the run goes on. Use it to measure before you enforce.
- "return" is not supported here (a callback cannot return a replacement value
  to LangChain) and raises ValueError. Use `guarded_tool(on_block="return")`.
"""
from __future__ import annotations
import logging
import warnings
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..guard import GuardBlockError, check_tool_call, check_tool_result, validate_on_block
from ..rules import evaluate

try:
    from langchain_core.callbacks.base import BaseCallbackHandler
except ImportError:
    class BaseCallbackHandler:  # type: ignore
        pass


ON_BLOCK_MODES = ("raise", "ignore")

_log = logging.getLogger("zn_gate")


def reject_return_mode(on_block: Any, where: str, instead: str) -> None:
    """Fail closed with a clear message when on_block='return' is asked of an integration that cannot return a value."""
    if on_block == "return":
        raise ValueError(
            f"on_block='return' is not supported by {where}: it cannot hand a replacement value back, "
            f"so a blocked input would go through. Use 'raise' (stop) or 'ignore' (log only); {instead}"
        )


class ZnGuardCallbackHandler(BaseCallbackHandler):
    """
    LangChain / LangGraph callback handler that stops prompt injection, sensitive
    path access and indirect injection in tool output by raising GuardBlockError.

    It cannot redact secrets: LangChain ignores callback return values. Wrap the
    tool with `guarded_tool` or `sanitize_tool_result` for that.

    Parameters:
    - on_block: "raise" (default) or "ignore" (log only). "return" raises ValueError.
    - mask_secrets: Deprecated and ignored. It never worked in a callback handler.
    - raise_on_injection: Legacy flag. True means "raise", False means "ignore"; it
                          wins over on_block.
    """
    # langchain-core only logs an exception raised by a handler unless this is
    # True, which would let the blocked call go ahead.
    raise_error = True

    def __init__(self, on_block: str = "raise", mask_secrets: Optional[bool] = None,
                 raise_on_injection: Optional[bool] = None):
        reject_return_mode(on_block, "ZnGuardCallbackHandler",
                           "to replace a blocked tool result, wrap the tool with guarded_tool(on_block='return').")
        on_block = validate_on_block(on_block, ON_BLOCK_MODES)
        if mask_secrets is not None:
            warnings.warn(
                "ZnGuardCallbackHandler(mask_secrets=...) is deprecated and has no effect: LangChain ignores "
                "what a callback returns, so a handler cannot redact a tool result. Wrap the tool with "
                "zn_gate.integrations.guarded_tool(...) or sanitize_tool_result(...) instead.",
                DeprecationWarning,
                stacklevel=2,
            )
        if raise_on_injection is not None:
            self.on_block = "raise" if raise_on_injection else "ignore"
        else:
            self.on_block = on_block

    def _handle(self, assessment: Any, target: str, payload: Any) -> None:
        if self.on_block == "raise":
            raise GuardBlockError(assessment, target=target, payload=payload)
        _log.warning("zn-gate (on_block='ignore', not blocked): %s matched rule %s", target, assessment.rule)

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: Optional[UUID] = None,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        for p in prompts:
            assessment = evaluate(p)
            if not assessment.allowed:
                self._handle(assessment, "langchain:llm_prompt", p)
        return None

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: Optional[UUID] = None,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        tool_name = serialized.get("name", "unknown_tool") if isinstance(serialized, dict) else "unknown_tool"
        target_payload = inputs if inputs is not None else input_str
        assessment = check_tool_call(tool_name, target_payload)
        if not assessment.allowed:
            self._handle(assessment, f"langchain:{tool_name}", target_payload)
        return None

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: Optional[UUID] = None,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> Any:
        # Stops indirect prompt injection in a tool output. It does not redact:
        # LangChain ignores this return value (see the module docstring).
        assessment = check_tool_result(output)
        if not assessment.allowed:
            self._handle(assessment, "langchain:tool_output", output)
        return None
