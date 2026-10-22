"""A native hook called without its framework installed names the pip package to install."""

import sys
import unittest
from unittest import mock

from zn_gate.integrations import native


class TestMissingFramework(unittest.TestCase):
    def test_openai_agents_names_the_package(self):
        with mock.patch.dict(sys.modules, {"agents": None, "agents.tool_guardrails": None}):
            with self.assertRaises(ImportError) as cm:
                native.openai_agents_tool_guardrails()
        self.assertIn("pip install openai-agents", str(cm.exception))

    def test_pydantic_ai_names_the_package(self):
        with mock.patch.dict(sys.modules, {"pydantic_ai": None, "pydantic_ai.toolsets": None}):
            with self.assertRaises(ImportError) as cm:
                native.guard_pydantic_ai_toolset(object())
        self.assertIn("pip install pydantic-ai", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
