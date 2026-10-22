"""
LangChain and LangGraph integration for zn-gate.
Zero hard dependencies on langchain.

Two pieces, because a LangChain callback can stop a run but cannot change it:

- `guard_langchain_tool(tool)` wraps a LangChain tool. It checks the arguments
  before the tool runs, checks what the tool returns, and hides secrets in that
  output before the model reads it. With on_block="return" the model gets a short
  block message instead of the tool output. Use it on every tool that reads
  outside data or can touch files, shells or the network.
- `ZnGuardCallbackHandler` is a callback for a whole agent, chain or model. It
  stops the run (raises GuardBlockError) when a prompt, a tool call or a tool
  output is blocked. It cannot replace a tool output: LangChain ignores what a
  callback returns. So a secret in a tool output also stops the run while
  mask_secrets is on, instead of being hidden.
"""
from __future__ import annotations
import contextvars
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..guard import (GuardBlockError, block_message, check_tool_call, check_tool_result, validate_on_block,
                     _error_texts, _mask_text, _mask_value, _rebuild_error, _safe_text, _secret_masked)
from ..rules import Assessment, evaluate, sanitize_tool_result

try:
    from langchain_core.callbacks.base import BaseCallbackHandler
    _HAVE_LANGCHAIN = True
except ImportError:
    _HAVE_LANGCHAIN = False

    class BaseCallbackHandler:  # type: ignore
        pass


ON_BLOCK_MODES = ("raise", "ignore")
TOOL_ON_BLOCK_MODES = ("raise", "return")

_RETURN_NOT_SUPPORTED = (
    "ZnGuardCallbackHandler does not support on_block='return': LangChain ignores what a "
    "callback returns, so a blocked call would run anyway. Use on_block='raise' to stop the "
    "run, or wrap the tool with guard_langchain_tool(tool, on_block='return') so the model "
    "gets a block message instead of the tool output."
)


def _output_content(output: Any) -> Any:
    """The part of a tool output the model reads: the content of a ToolMessage, else the output."""
    if isinstance(output, (str, bytes, dict, list, tuple)) or output is None:
        return output
    content = getattr(output, "content", None)
    return output if content is None else content


def _error_secrets(error: BaseException) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    for text in _error_texts(error):
        _, detections = sanitize_tool_result(text)
        found.extend(detections)
    return found


def _secret_assessment(found: List[Dict[str, Any]]) -> Assessment:
    rules = sorted({str(f.get("rule", "secret")) for f in found})
    return Assessment(
        verdict="block",
        confidence=1.0,
        rule=rules[0] if rules else "secret",
        reason=("Tool output contains a secret, and a callback cannot hide it before the model "
                "reads it; wrap the tool with guard_langchain_tool to hide secrets instead"),
    )


class ZnGuardCallbackHandler(BaseCallbackHandler):
    """
    LangChain / LangGraph callback handler that stops a run when zn-gate blocks a
    prompt, a tool call or a tool output.

    Pass it in `callbacks=[handler]` (or `config={"callbacks": [handler]}`) to an
    agent, chain, model or tool. With on_block="raise" (default) a block raises
    GuardBlockError out of the run: a blocked tool call does not run, and a
    blocked tool output does not reach the model.

    What a callback cannot do: LangChain ignores its return value, so it cannot
    replace or redact a tool output. With mask_secrets=True (default) a tool
    output that contains a secret therefore stops the run as well. To hide the
    secret and keep the run going, or to hand the model a block message, wrap
    the tool with `guard_langchain_tool`. The same goes for a tool's error: when
    its message is blocked or contains a secret, the error is replaced by
    GuardBlockError, because error handlers such as LangGraph's ToolNode send
    the error text to the model.

    Parameters:
    - on_block: "raise" (default) stops the run with GuardBlockError; "ignore"
                checks nothing that stops the run. "return" is not supported
                here (it raises ValueError): use guard_langchain_tool.
    - mask_secrets: Treat a secret in a tool output as a block (default True).
    - block_truncated: Block a tool output too large to scan in full
                       (rule size:truncated) (default False).
    """

    # LangChain logs and swallows exceptions from a callback unless the handler
    # sets raise_error. Without it a block would only write a warning.
    raise_error: bool = True

    def __init__(self, on_block: str = "raise", mask_secrets: bool = True,
                 raise_on_injection: Optional[bool] = None, block_truncated: bool = False):
        if on_block == "return":
            raise ValueError(_RETURN_NOT_SUPPORTED)
        on_block = validate_on_block(on_block, ON_BLOCK_MODES)
        if raise_on_injection is not None:
            self.on_block = "raise" if raise_on_injection else "ignore"
        else:
            self.on_block = on_block
        self.mask_secrets = mask_secrets
        self.block_truncated = block_truncated

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
        # Chat models reach this method too: LangChain turns the messages into
        # text and calls on_llm_start when a handler has no on_chat_model_start.
        for p in prompts:
            assessment = evaluate(p)
            if not assessment.allowed:
                if self.on_block == "raise":
                    raise GuardBlockError(assessment, target="langchain:llm_prompt", payload=p)
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
            if self.on_block == "raise":
                raise GuardBlockError(assessment, target=f"langchain:{tool_name}", payload=target_payload)
        return None

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: Optional[UUID] = None,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> Any:
        """Stop the run when the tool output is blocked.

        LangChain ignores the return value. For direct callers it is the output
        with secrets hidden (when mask_secrets is on and nothing was blocked).
        """
        content = _output_content(output)
        assessment = check_tool_result(content, block_truncated=self.block_truncated)
        if not assessment.allowed:
            if self.on_block == "raise":
                raise GuardBlockError(assessment, target="langchain:tool_output", payload=content)
            return output
        if not self.mask_secrets:
            return output
        masked, unmaskable = _mask_value(content)
        if unmaskable is not None:
            if self.on_block == "raise":
                raise GuardBlockError(unmaskable, target="langchain:tool_output", payload=None)
            return output
        changed = _secret_masked(content, masked)
        if changed and self.on_block == "raise":
            _, found = sanitize_tool_result(content)
            raise GuardBlockError(_secret_assessment(found), target="langchain:tool_output", payload=masked)
        return masked if changed else output

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: Optional[UUID] = None,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> Any:
        """Replace a tool's error with GuardBlockError when its message is blocked
        or, with mask_secrets, contains a secret.

        Error handlers such as LangGraph's ToolNode(handle_tool_errors=True)
        send the error text to the model, and a callback cannot rewrite it, so
        the error is replaced by GuardBlockError (whose message holds no
        secret) and the run stops, or the handler passes the block message on.
        An error LangChain itself handles (ToolException with
        handle_tool_error) becomes a tool output and goes through on_tool_end.
        """
        if self.on_block != "raise" or not isinstance(error, Exception) or isinstance(error, GuardBlockError):
            return None
        texts = _error_texts(error)
        message = texts[0] if texts else ""
        assessment = check_tool_result(texts[:2], block_truncated=self.block_truncated)
        if not assessment.allowed:
            raise GuardBlockError(assessment, target="langchain:tool_output", payload=_mask_text(message))
        if self.mask_secrets:
            found = _error_secrets(error)
            if found:
                raise GuardBlockError(_secret_assessment(found), target="langchain:tool_output",
                                      payload=_mask_text(message))
        return None


def _guard_settings(on_block: str) -> str:
    return validate_on_block(on_block, TOOL_ON_BLOCK_MODES)


if _HAVE_LANGCHAIN:
    from langchain_core.callbacks import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
    from langchain_core.runnables import RunnableConfig
    from langchain_core.runnables.config import patch_config
    from langchain_core.messages import ToolMessage
    from langchain_core.tools import BaseTool

    # The id of the tool call being run. BaseTool passes it to run()/arun() but not to
    # _run(), and a wrapped tool with an InjectedToolCallId argument or an artifact needs it.
    _CALL_ID: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("zn_gate_tool_call_id", default=None)

    # Injected arguments whose value the model cannot choose: LangChain always sets InjectedToolCallId from the
    # tool call, and LangGraph's ToolNode always sets InjectedState and InjectedStore. A generic InjectedToolArg is
    # filled in by the application, but LangChain still accepts a value the model sends for it, so it stays checked.
    _OVERWRITTEN = frozenset({"InjectedToolCallId", "InjectedState", "InjectedStore"})

    def _marks(meta: Any) -> frozenset:
        cls = meta if isinstance(meta, type) else type(meta)
        return frozenset(c.__name__ for c in getattr(cls, "__mro__", ()))

    def _injected_keys(tool: Any) -> frozenset:
        """Names of the injected arguments the model cannot set (see _OVERWRITTEN); they are not checked."""
        try:
            full = getattr(tool.get_input_schema(), "model_fields", None) or {}
            visible = getattr(tool.tool_call_schema, "model_fields", None) or {}
            keys = set()
            for name, field in full.items():
                if name in visible:
                    continue
                metas = list(getattr(field, "metadata", None) or [])
                for arg in getattr(getattr(field, "annotation", None), "__metadata__", ()) or ():
                    metas.append(arg)
                if any(_marks(m) & _OVERWRITTEN for m in metas):
                    keys.add(name)
            return frozenset(keys)
        except Exception:
            return frozenset()

    class ZnGuardedTool(BaseTool):  # type: ignore[misc]
        """A LangChain tool that runs another tool behind zn-gate. Build it with guard_langchain_tool."""

        tool: BaseTool
        on_block: str = "raise"
        mask_secrets: bool = True
        check_result: bool = True
        block_truncated: bool = False
        fallback: Optional[str] = None

        def run(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
            token = _CALL_ID.set(kwargs.get("tool_call_id"))
            try:
                return super().run(*args, **kwargs)
            finally:
                _CALL_ID.reset(token)

        async def arun(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
            token = _CALL_ID.set(kwargs.get("tool_call_id"))
            try:
                return await super().arun(*args, **kwargs)
            finally:
                _CALL_ID.reset(token)

        @property
        def _artifact(self) -> bool:
            return self.response_format == "content_and_artifact"

        def _pack(self, content: Any, artifact: Any = None) -> Any:
            """Give BaseTool what it expects from _run: (content, artifact) for an artifact tool."""
            return (content, artifact) if self._artifact else content

        def _inner_call(self, tool_input: Any) -> Any:
            """What the wrapped tool is invoked with: a full ToolCall when it needs the call id
            (InjectedToolCallId) or returns an artifact (only a ToolMessage carries it), else the arguments."""
            call_id = _CALL_ID.get()
            if isinstance(tool_input, dict) and (self._artifact or (call_id and _injected_keys(self.tool))):
                return {"name": self.tool.name, "args": tool_input, "id": call_id or "zn-gate", "type": "tool_call"}
            return tool_input

        def _unpack(self, result: Any) -> Tuple[Any, Any]:
            if isinstance(result, ToolMessage):
                return result.content, result.artifact
            return result, None

        def _input(self, args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Any:
            if kwargs:
                return kwargs
            if len(args) == 1:
                return args[0]
            return {}

        def _blocked(self, assessment: Assessment, target: str, payload: Any) -> Any:
            if self.on_block == "raise":
                raise GuardBlockError(assessment, target=target, payload=payload)
            if self.fallback is not None:
                return self.fallback
            return block_message(assessment, target)

        def _before(self, tool_input: Any) -> Optional[Assessment]:
            injected = _injected_keys(self.tool)
            if injected and isinstance(tool_input, dict):
                # Arguments the model cannot set (call id, LangGraph state/store) are not checked; the rest is.
                tool_input = {k: v for k, v in tool_input.items() if k not in injected}
            assessment = check_tool_call(self.name, tool_input)
            return None if assessment.allowed else assessment

        def _after(self, result: Any) -> Any:
            target = f"langchain:{self.name}:result"
            if self.check_result:
                assessment = check_tool_result(result, block_truncated=self.block_truncated)
                if not assessment.allowed:
                    return self._blocked(assessment, target, result)
            if self.mask_secrets:
                result, unmaskable = _mask_value(result)
                if unmaskable is not None:
                    return self._blocked(unmaskable, target, None)
            return result

        def _error(self, error: Exception) -> Any:
            """Check and mask a tool's exception like its output, because LangChain
            (handle_tool_error) and LangGraph (ToolNode) send its text to the model.

            Called outside the `except` block, so what is raised in its place has
            no link back to the original. A blocked message is handled like a
            blocked output; a message with a secret is raised again as the same
            exception type carrying only the masked message (so handle_tool_error
            still handles a ToolException); other errors are raised unchanged.
            """
            message = _safe_text(str, error)
            if self.check_result:
                assessment = check_tool_result([message, _safe_text(repr, error)],
                                               block_truncated=self.block_truncated)
                if not assessment.allowed:
                    return self._blocked(assessment, f"langchain:{self.name}:result",
                                         _mask_text(message) if self.mask_secrets else None)
            if self.mask_secrets and _error_secrets(error):
                masked = _rebuild_error(error, _mask_text(message))
                raise masked.with_traceback(error.__traceback__) from None
            raise error

        def _run(self, *args: Any, config: RunnableConfig,
                 run_manager: Optional[CallbackManagerForToolRun] = None, **kwargs: Any) -> Any:
            tool_input = self._input(args, kwargs)
            blocked = self._before(tool_input)
            if blocked is not None:
                return self._pack(self._blocked(blocked, f"langchain:{self.name}", tool_input))
            child = patch_config(config, callbacks=run_manager.get_child()) if run_manager else config
            caught: Optional[Exception] = None
            try:
                result = self.tool.invoke(self._inner_call(tool_input), config=child)
            except GuardBlockError:
                raise
            except Exception as exc:
                if not (self.check_result or self.mask_secrets):
                    raise
                caught = exc
            if caught is not None:
                return self._pack(self._error(caught))
            content, artifact = self._unpack(result)
            return self._pack(self._after(content), artifact)

        async def _arun(self, *args: Any, config: RunnableConfig,
                        run_manager: Optional[AsyncCallbackManagerForToolRun] = None, **kwargs: Any) -> Any:
            tool_input = self._input(args, kwargs)
            blocked = self._before(tool_input)
            if blocked is not None:
                return self._pack(self._blocked(blocked, f"langchain:{self.name}", tool_input))
            child = patch_config(config, callbacks=run_manager.get_child()) if run_manager else config
            caught: Optional[Exception] = None
            try:
                result = await self.tool.ainvoke(self._inner_call(tool_input), config=child)
            except GuardBlockError:
                raise
            except Exception as exc:
                if not (self.check_result or self.mask_secrets):
                    raise
                caught = exc
            if caught is not None:
                return self._pack(self._error(caught))
            content, artifact = self._unpack(result)
            return self._pack(self._after(content), artifact)


def guard_langchain_tool(
    tool: Any,
    on_block: str = "raise",
    mask_secrets: bool = True,
    check_result: bool = True,
    block_truncated: bool = False,
    fallback: Optional[str] = None,
) -> Any:
    """
    Wrap a LangChain tool so zn-gate checks its arguments before it runs and its
    output before the model reads it. Returns a new tool with the same name,
    description and arguments; pass it to your agent instead of the original.

    Parameters:
    - on_block: "raise" (default) raises GuardBlockError (target
                "langchain:<tool>" for arguments, "langchain:<tool>:result" for
                the output); "return" gives the model `fallback`, or the plain
                block message when fallback is None, and the tool does not run
                (for a blocked output: its output is dropped).
    - mask_secrets: Hide credentials in the tool output (default True).
    - check_result: Scan the tool output for prompt injection (default True).
    - block_truncated: Block an output too large to scan in full (default False).
    - fallback: Text the model gets for a block when on_block="return".

    The message of an exception raised by the tool is checked and masked like
    its output, because handle_tool_error and LangGraph's ToolNode send it to
    the model: a blocked message is handled like a blocked output, and a
    message with a secret is raised again as the same exception type carrying
    only the masked message (MaskedToolError, a RuntimeError, when the type
    cannot be rebuilt that way). The returned tool keeps the original's
    handle_tool_error and handle_validation_error.

    A tool with response_format="content_and_artifact" keeps it: the content
    is checked and masked, the artifact is passed through unchanged (it is not
    scanned; LangChain does not send it to the model). Arguments LangChain
    fills in are passed on untouched. InjectedToolCallId and LangGraph's
    InjectedState and InjectedStore are not checked (the model cannot set them);
    a generic InjectedToolArg is checked like any other argument, because
    LangChain accepts a value the model sends for it.

    If you also use ZnGuardCallbackHandler, create it with mask_secrets=False:
    the handler sees the wrapped tool's raw output and would stop the run on a
    secret before the wrapper can mask it.
    """
    if not _HAVE_LANGCHAIN:
        raise ImportError("guard_langchain_tool needs langchain-core: pip install langchain-core")
    if not isinstance(tool, BaseTool):
        raise TypeError("guard_langchain_tool expects a LangChain tool (BaseTool); "
                        "decorate a plain function with @tool from langchain_core.tools first")
    on_block = _guard_settings(on_block)
    return ZnGuardedTool(
        tool=tool,
        name=tool.name,
        description=tool.description,
        args_schema=tool.args_schema,
        return_direct=tool.return_direct,
        response_format=tool.response_format,
        handle_tool_error=tool.handle_tool_error,
        handle_validation_error=tool.handle_validation_error,
        on_block=on_block,
        mask_secrets=mask_secrets,
        check_result=check_result,
        block_truncated=block_truncated,
        fallback=fallback,
    )
