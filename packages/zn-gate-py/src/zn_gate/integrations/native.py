"""
Native tool hooks for agent frameworks whose tools never pass through
`guard` or `guarded_tool`: Google ADK, the OpenAI Agents SDK and Pydantic AI.

Each helper plugs zn-gate into the place the framework documents for checking
a tool call and its result, so tools the framework supplies itself (MCP
toolsets, for example) are covered too. None of them imports its framework
until you call it.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..guard import (GuardBlockError, _is_framework_context, _mask_value, _secret_masked, block_message, check_tool_call,
                     check_tool_result, validate_on_block)


class _Policy:
    """The checks shared by the three hooks."""

    def __init__(self, framework: str, on_block: str, mask_secrets: bool, check_result: bool,
                 block_truncated: bool, fallback: Optional[str]):
        self.framework = framework
        self.on_block = validate_on_block(on_block, ("return", "raise"))
        self.mask = mask_secrets
        self.check_result = check_result
        self.block_truncated = block_truncated
        self.fallback = fallback

    def target(self, tool_name: str, result: bool = False) -> str:
        return f"{self.framework}:{tool_name}" + (":result" if result else "")

    def message(self, assessment: Any, target: str) -> str:
        return self.fallback if self.fallback is not None else block_message(assessment, target)

    def input_assessment(self, tool_name: str, arguments: Any) -> Any:
        """The blocking assessment, or None when the call may run."""
        if isinstance(arguments, dict):
            arguments = {k: v for k, v in arguments.items() if not _is_framework_context(v)}
        res = check_tool_call(tool_name, arguments, block_truncated=self.block_truncated)
        return None if res.allowed else res

    def output(self, result: Any) -> Tuple[Any, Any, bool]:
        """(blocking assessment or None, output to use, whether masking changed it)."""
        if self.check_result:
            res = check_tool_result(result, block_truncated=self.block_truncated)
            if not res.allowed:
                return res, None, True
        if self.mask:
            clean, unmaskable = _mask_value(result)
            if unmaskable is not None:
                return unmaskable, None, True
            return None, clean, _secret_masked(result, clean)
        return None, result, False

    def raise_block(self, assessment: Any, tool_name: str, payload: Any, result: bool = False) -> None:
        raise GuardBlockError(assessment, target=self.target(tool_name, result), payload=payload)


# --- Google ADK ---------------------------------------------------------------

def adk_tool_callbacks(
    on_block: str = "return",
    mask_secrets: bool = True,
    check_result: bool = True,
    block_truncated: bool = False,
    fallback: Optional[str] = None,
) -> Tuple[Callable[..., Any], Callable[..., Any]]:
    """
    `(before_tool_callback, after_tool_callback)` for a Google ADK `LlmAgent`:

        before, after = adk_tool_callbacks()
        agent = LlmAgent(..., before_tool_callback=before, after_tool_callback=after)

    The before callback checks the arguments the model chose; a blocked call
    does not run, and the callback's `{"error": <message>}` becomes the tool
    response, as ADK documents for a before callback that returns a dict. The
    after callback checks the tool response for prompt injection and masks
    secrets; it returns the replacement dict only when it changes something.
    ADK skips the after callback when the before callback answered the call.
    A tool output over 4 MB cannot be checked in full and is blocked by default
    (rule size:truncated); ZN_ALLOW_TRUNCATED=1 lets it through, and
    block_truncated=True keeps it blocked even then.

    on_block="raise" raises GuardBlockError instead of returning a response.
    The ADK `ToolContext` is not checked. Tool exceptions are not covered
    (ADK's `on_tool_error_callback` is separate).
    """
    policy = _Policy("adk", on_block, mask_secrets, check_result, block_truncated, fallback)

    def before_tool_callback(tool: Any, args: Dict[str, Any], tool_context: Any = None) -> Optional[Dict[str, Any]]:
        name = getattr(tool, "name", None) or "tool"
        blocked = policy.input_assessment(name, args)
        if blocked is None:
            return None
        if policy.on_block == "raise":
            policy.raise_block(blocked, name, args)
        return {"error": policy.message(blocked, policy.target(name))}

    def after_tool_callback(tool: Any, args: Dict[str, Any], tool_context: Any = None,
                            tool_response: Any = None) -> Optional[Dict[str, Any]]:
        name = getattr(tool, "name", None) or "tool"
        blocked, clean, changed = policy.output(tool_response)
        if blocked is not None:
            if policy.on_block == "raise":
                policy.raise_block(blocked, name, tool_response, result=True)
            return {"error": policy.message(blocked, policy.target(name, True))}
        if not changed:
            return None
        return clean if isinstance(clean, dict) else {"result": clean}

    return before_tool_callback, after_tool_callback


# --- OpenAI Agents SDK --------------------------------------------------------

def openai_agents_tool_guardrails(
    on_block: str = "return",
    mask_secrets: bool = True,
    check_result: bool = True,
    block_truncated: bool = False,
    fallback: Optional[str] = None,
) -> Tuple[List[Any], List[Any]]:
    """
    `(tool_input_guardrails, tool_output_guardrails)` for the OpenAI Agents SDK:

        inputs, outputs = openai_agents_tool_guardrails()
        @function_tool(tool_input_guardrails=inputs, tool_output_guardrails=outputs)
        def fetch(url: str) -> str: ...

    The same lists go on `MCPServerStdio(..., tool_input_guardrails=...,
    tool_output_guardrails=...)` and the other MCP servers, to cover every tool
    of that server. A blocked call does not run: the SDK sends the model the
    zn-gate message instead (`reject_content`). A secret in the output is
    masked the only way the SDK allows, by replacing the output with the
    masked text (JSON text for a dict or list); the output is untouched when
    nothing needs masking.

    on_block="raise" makes the guardrail trip the SDK's own tripwire
    (`ToolInputGuardrailTripwireTriggered` / `ToolOutputGuardrailTripwireTriggered`).
    Hosted tools (web search, code interpreter, ...) have no tool guardrails in
    the SDK and are not covered.

    A tool output over 4 MB cannot be checked in full and is blocked by default
    (rule size:truncated); ZN_ALLOW_TRUNCATED=1 lets it through, and
    block_truncated=True keeps it blocked even then.
    """
    policy = _Policy("openai-agents", on_block, mask_secrets, check_result, block_truncated, fallback)
    try:
        from agents.tool_guardrails import ToolGuardrailFunctionOutput, ToolInputGuardrail, ToolOutputGuardrail
    except ImportError as exc:
        raise ImportError("openai_agents_tool_guardrails needs the OpenAI Agents SDK: pip install openai-agents") from exc

    def _arguments(raw: Any) -> Any:
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except ValueError:
                return raw
        return raw

    def zn_gate_tool_input(data: Any) -> Any:
        name = getattr(data.context, "tool_name", None) or "tool"
        blocked = policy.input_assessment(name, _arguments(getattr(data.context, "tool_arguments", None)))
        if blocked is None:
            return ToolGuardrailFunctionOutput.allow()
        info = {"rule": blocked.rule}
        if policy.on_block == "raise":
            return ToolGuardrailFunctionOutput.raise_exception(info)
        return ToolGuardrailFunctionOutput.reject_content(policy.message(blocked, policy.target(name)), info)

    def zn_gate_tool_output(data: Any) -> Any:
        name = getattr(data.context, "tool_name", None) or "tool"
        blocked, clean, changed = policy.output(data.output)
        if blocked is not None:
            info = {"rule": blocked.rule}
            if policy.on_block == "raise":
                return ToolGuardrailFunctionOutput.raise_exception(info)
            return ToolGuardrailFunctionOutput.reject_content(policy.message(blocked, policy.target(name, True)), info)
        if not changed:
            return ToolGuardrailFunctionOutput.allow()
        text = clean if isinstance(clean, str) else json.dumps(clean, default=str)
        return ToolGuardrailFunctionOutput.reject_content(text, {"masked": True})

    return ([ToolInputGuardrail(guardrail_function=zn_gate_tool_input, name="zn_gate_tool_input")],
            [ToolOutputGuardrail(guardrail_function=zn_gate_tool_output, name="zn_gate_tool_output")])


# --- Pydantic AI --------------------------------------------------------------

def guard_pydantic_ai_toolset(
    toolset: Any,
    on_block: str = "return",
    mask_secrets: bool = True,
    check_result: bool = True,
    block_truncated: bool = False,
    fallback: Optional[str] = None,
) -> Any:
    """
    Wrap a Pydantic AI toolset (an MCP server, `FunctionToolset`, a combined
    toolset...) so every call through it is checked, using Pydantic AI's
    documented `WrapperToolset.call_tool` override:

        agent = Agent(model, toolsets=[guard_pydantic_ai_toolset(server)])

    A blocked call does not run: the tool result is the zn-gate message
    (on_block="return") or `GuardBlockError` is raised (on_block="raise"). The
    result is checked for prompt injection and secrets in it are masked. The
    `RunContext` is not checked. Tools added with `@agent.tool` are not in a
    toolset you hold: put them in a `FunctionToolset` and wrap that, or use
    `guarded_tool`.

    A tool output over 4 MB cannot be checked in full and is blocked by default
    (rule size:truncated); ZN_ALLOW_TRUNCATED=1 lets it through, and
    block_truncated=True keeps it blocked even then.
    """
    try:
        from pydantic_ai.toolsets import WrapperToolset
    except ImportError as exc:
        raise ImportError("guard_pydantic_ai_toolset needs Pydantic AI: pip install pydantic-ai") from exc

    policy = _Policy("pydantic-ai", on_block, mask_secrets, check_result, block_truncated, fallback)

    class ZnGuardToolset(WrapperToolset):  # type: ignore[misc]
        async def call_tool(self, name: str, tool_args: Dict[str, Any], ctx: Any, tool: Any) -> Any:
            blocked = policy.input_assessment(name, tool_args)
            if blocked is not None:
                if policy.on_block == "raise":
                    policy.raise_block(blocked, name, tool_args)
                return policy.message(blocked, policy.target(name))
            result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
            blocked, clean, _ = policy.output(result)
            if blocked is not None:
                if policy.on_block == "raise":
                    policy.raise_block(blocked, name, result, result=True)
                return policy.message(blocked, policy.target(name, True))
            return clean

    return ZnGuardToolset(toolset)
