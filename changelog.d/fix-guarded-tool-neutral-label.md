### Changed
- `guarded_tool` now names blocked targets `tool:<name>` instead of `crewai:<name>`, so messages read correctly with Pydantic AI, Google ADK or plain Python. New optional `framework` argument sets the prefix; pass `framework="crewai"` to keep the old label.
