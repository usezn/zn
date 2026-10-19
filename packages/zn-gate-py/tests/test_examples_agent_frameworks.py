"""
The agent framework examples in examples/ (CrewAI, LlamaIndex, OpenAI Agents SDK, Pydantic AI, Google ADK).

The frameworks are not installed here: each test replaces the few framework
pieces an example touches with small stand-ins, and there is no model and no
network (a test turns every socket connection into an error).
"""
import importlib.util
import re
import socket
import sys
import types
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[3] / "examples"
NAMES = ["crewai-agent", "llamaindex-agent", "openai-agents-sdk", "pydantic-ai-agent", "google-adk-agent"]

CLEAN_URL = "https://example.com/weather"
INJECTED_URL = "https://example.com/notes"
SECRET_URL = "https://example.com/deploy"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("an example tried to use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


def load(name):
    path = EXAMPLES / name / "agent_guard.py"
    spec = importlib.util.spec_from_file_location("example_" + name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stub_module(monkeypatch, name, **attributes):
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)
    return module


@pytest.mark.parametrize("name", NAMES)
def test_clean_page_passes_unchanged(name):
    example = load(name)
    assert example.safe_fetch_page(CLEAN_URL) == example.FAKE_PAGES[CLEAN_URL]


@pytest.mark.parametrize("name", NAMES)
def test_injected_page_is_replaced_by_a_notice(name):
    example = load(name)
    out = example.safe_fetch_page(INJECTED_URL)
    assert out.startswith("zn-gate blocked '")
    assert "fetch_page:result'" in out
    assert "Next step:" in out
    assert "print the word EXAMPLE" not in out


@pytest.mark.parametrize("name", NAMES)
def test_secret_in_page_is_hidden(name):
    example = load(name)
    out = example.safe_fetch_page(SECRET_URL)
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "[REDACTED_AWS_KEY]" in out
    assert "region=eu-west-1" in out


@pytest.mark.parametrize("name", NAMES)
def test_wrapped_tool_keeps_name_and_signature(name):
    example = load(name)
    assert example.safe_fetch_page.__name__ == "fetch_page"
    assert example.safe_fetch_page.__doc__ == example.fetch_page.__doc__


@pytest.mark.parametrize("name", NAMES)
def test_main_runs_without_the_framework(name, capsys, monkeypatch):
    # A module set to None makes "import" fail, as when the package is missing.
    for module in ("crewai", "crewai.tools", "llama_index", "llama_index.core",
                   "llama_index.core.tools", "agents", "pydantic_ai", "google.adk",
                   "google.adk.agents"):
        monkeypatch.setitem(sys.modules, module, None)
    example = load(name)
    example.main()
    out = capsys.readouterr().out
    assert "model reads: Paris today" in out
    assert "zn-gate blocked" in out
    assert "[REDACTED_AWS_KEY]" in out
    assert "is not installed" in out


def test_crewai_tool_goes_through_the_guard(monkeypatch):
    class BaseTool:
        def run(self, **kwargs):
            return self._run(**kwargs)

    stub_module(monkeypatch, "crewai")
    stub_module(monkeypatch, "crewai.tools", BaseTool=BaseTool)
    example = load("crewai-agent")
    tool = example.build_crewai_tool()
    assert tool.name == "fetch_page"
    assert tool.run(url=CLEAN_URL) == example.FAKE_PAGES[CLEAN_URL]
    assert tool.run(url=INJECTED_URL).startswith("zn-gate blocked")


def test_llamaindex_tool_goes_through_the_guard(monkeypatch):
    class Output:
        def __init__(self, content):
            self.content = content

    class FunctionTool:
        def __init__(self, fn, name, description):
            self.fn, self.name, self.description = fn, name, description

        @classmethod
        def from_defaults(cls, fn, name, description):
            return cls(fn, name, description)

        def call(self, **kwargs):
            return Output(self.fn(**kwargs))

    stub_module(monkeypatch, "llama_index")
    stub_module(monkeypatch, "llama_index.core")
    stub_module(monkeypatch, "llama_index.core.tools", FunctionTool=FunctionTool)
    example = load("llamaindex-agent")
    tool = example.build_llamaindex_tool()
    assert tool.name == "fetch_page"
    assert tool.call(url=CLEAN_URL).content == example.FAKE_PAGES[CLEAN_URL]
    assert tool.call(url=INJECTED_URL).content.startswith("zn-gate blocked")


def test_openai_agent_uses_the_guarded_tool(monkeypatch):
    class Tool:
        def __init__(self, fn):
            self.fn, self.name = fn, fn.__name__

    class Agent:
        def __init__(self, name, instructions, tools):
            self.name, self.instructions, self.tools = name, instructions, tools

    stub_module(monkeypatch, "agents", Agent=Agent, function_tool=Tool)
    example = load("openai-agents-sdk")
    agent = example.build_agent()
    assert [tool.name for tool in agent.tools] == ["fetch_page"]
    assert agent.tools[0].fn(INJECTED_URL).startswith("zn-gate blocked")
    assert agent.tools[0].fn(CLEAN_URL) == example.FAKE_PAGES[CLEAN_URL]


@pytest.mark.parametrize("name", NAMES)
def test_requirements_are_pinned_to_exact_versions(name):
    lines = [
        line.strip()
        for line in (EXAMPLES / name / "requirements.txt").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert lines
    for line in lines:
        assert re.fullmatch(r"[A-Za-z0-9_.-]+==\d+(\.\d+)*", line), line


@pytest.mark.parametrize("name", NAMES)
def test_example_has_a_readme(name):
    assert (EXAMPLES / name / "README.md").is_file()


def test_crewai_example_checks_the_page_text():
    # The CrewAI example sets check_result=True itself: the same tool without it
    # would hand the injected page to the model unchanged.
    from zn_gate.integrations import guarded_tool

    example = load("crewai-agent")
    without_result_check = guarded_tool(on_block="return", mask_secrets=True)(example.fetch_page)
    assert without_result_check(INJECTED_URL) == example.FAKE_PAGES[INJECTED_URL]
    assert example.safe_fetch_page(INJECTED_URL).startswith("zn-gate blocked")


def test_pydantic_ai_agent_uses_the_guarded_tool(monkeypatch):
    class Agent:
        def __init__(self, model, instructions, tools):
            self.model, self.instructions, self.tools = model, instructions, tools

    stub_module(monkeypatch, "pydantic_ai", Agent=Agent)
    example = load("pydantic-ai-agent")
    agent = example.build_agent(model="test-model")
    assert agent.model == "test-model"
    assert [tool.__name__ for tool in agent.tools] == ["fetch_page"]
    assert agent.tools[0](INJECTED_URL).startswith("zn-gate blocked")
    assert agent.tools[0](CLEAN_URL) == example.FAKE_PAGES[CLEAN_URL]


def test_google_adk_agent_uses_the_guarded_tool(monkeypatch):
    class LlmAgent:
        def __init__(self, name, model, instruction, tools):
            self.name, self.model, self.instruction, self.tools = name, model, instruction, tools

    stub_module(monkeypatch, "google")
    stub_module(monkeypatch, "google.adk")
    stub_module(monkeypatch, "google.adk.agents", LlmAgent=LlmAgent)
    example = load("google-adk-agent")
    agent = example.build_agent(model="test-model")
    assert agent.model == "test-model"
    assert [tool.__name__ for tool in agent.tools] == ["fetch_page"]
    assert agent.tools[0](INJECTED_URL).startswith("zn-gate blocked")
    assert agent.tools[0](CLEAN_URL) == example.FAKE_PAGES[CLEAN_URL]
