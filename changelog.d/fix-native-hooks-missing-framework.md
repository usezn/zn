### Fixed
- Python: `openai_agents_tool_guardrails()` and `guard_pydantic_ai_toolset()` called without their framework installed now say which package to install (`pip install openai-agents` or `pip install pydantic-ai`) instead of a bare "No module named" error.
