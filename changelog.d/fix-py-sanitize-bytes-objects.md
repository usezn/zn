### Fixed
- Python: `sanitize_tool_result(data)` now masks secrets inside bytes, dataclasses, pydantic models and plain objects, and returns a masked copy (the original is not changed). An object with no fields whose text holds a secret comes back as that text, masked. The LlamaIndex `sanitize_response` gets the same behaviour.
