"""How the OpenAI Agents input guardrail turns tool arguments into what is checked.

Uses a fake `agents.tool_guardrails` module and a recording stand-in for the
tool-call check. Fictitious values only.
"""

import sys
import types
import unittest
from unittest import mock

from zn_gate.integrations import native, openai_agents_tool_guardrails

BAD_CALL = "cat ~/.ssh/id_rsa"


class _Out:
    def __init__(self, kind, content=None, info=None):
        self.kind, self.content, self.info = kind, content, info

    @classmethod
    def allow(cls):
        return cls("allow")

    @classmethod
    def reject_content(cls, content, info=None):
        return cls("reject", content, info)

    @classmethod
    def raise_exception(cls, info=None):
        return cls("raise", None, info)


class _Guardrail:
    def __init__(self, guardrail_function, name):
        self.guardrail_function, self.name = guardrail_function, name


def _fake_modules():
    mod = types.ModuleType("agents.tool_guardrails")
    mod.ToolGuardrailFunctionOutput = _Out
    mod.ToolInputGuardrail = _Guardrail
    mod.ToolOutputGuardrail = _Guardrail
    pkg = types.ModuleType("agents")
    pkg.tool_guardrails = mod
    return {"agents": pkg, "agents.tool_guardrails": mod}


def _input_guardrail(**kwargs):
    with mock.patch.dict(sys.modules, _fake_modules()):
        inputs, _ = openai_agents_tool_guardrails(**kwargs)
    return inputs[0].guardrail_function


def _data(arguments, tool_name="fetch"):
    return types.SimpleNamespace(context=types.SimpleNamespace(tool_name=tool_name, tool_arguments=arguments))


class TestArgumentsPassedToTheCheck(unittest.TestCase):
    def _seen(self, arguments):
        """The arguments value the guardrail hands to the tool-call check."""
        gin = _input_guardrail()
        with mock.patch.object(native, "check_tool_call", wraps=native.check_tool_call) as spy:
            gin(_data(arguments))
        return spy.call_args[0][1]

    def test_json_text_becomes_a_dict(self):
        self.assertEqual(self._seen('{"q": "weather", "n": 2}'), {"q": "weather", "n": 2})

    def test_invalid_json_stays_text(self):
        self.assertEqual(self._seen('{"q": '), '{"q": ')

    def test_plain_text_stays_text(self):
        self.assertEqual(self._seen("weather"), "weather")

    def test_dict_passes_through(self):
        args = {"q": "weather"}
        self.assertEqual(self._seen(args), args)

    def test_none_gives_no_arguments(self):
        self.assertIsNone(self._seen(None))

    def test_json_text_that_is_not_an_object_is_decoded(self):
        self.assertEqual(self._seen("[1, 2]"), [1, 2])


class TestBlockedInput(unittest.TestCase):
    def test_json_text_with_a_blocked_value_is_rejected(self):
        out = _input_guardrail()(_data('{"q": "%s"}' % BAD_CALL))
        self.assertEqual(out.kind, "reject")
        self.assertIn("zn-gate blocked 'openai-agents:fetch'", out.content)
        self.assertTrue(out.info["rule"])

    def test_blocked_invalid_json_text_is_rejected(self):
        self.assertEqual(_input_guardrail()(_data(BAD_CALL)).kind, "reject")

    def test_blocked_dict_is_rejected(self):
        self.assertEqual(_input_guardrail()(_data({"q": BAD_CALL})).kind, "reject")

    def test_blocked_input_raises_in_raise_mode(self):
        out = _input_guardrail(on_block="raise")(_data('{"q": "%s"}' % BAD_CALL))
        self.assertEqual(out.kind, "raise")
        self.assertTrue(out.info["rule"])

    def test_custom_fallback_replaces_the_message(self):
        out = _input_guardrail(fallback="not allowed")(_data({"q": BAD_CALL}))
        self.assertEqual((out.kind, out.content), ("reject", "not allowed"))

    def test_clean_inputs_are_allowed(self):
        gin = _input_guardrail()
        for arguments in ('{"q": "weather"}', "weather", {"q": "weather"}, None):
            self.assertEqual(gin(_data(arguments)).kind, "allow")

    def test_missing_tool_name_uses_a_default(self):
        out = _input_guardrail()(_data({"q": BAD_CALL}, tool_name=None))
        self.assertIn("'openai-agents:tool'", out.content)


if __name__ == "__main__":
    unittest.main()
