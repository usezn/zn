### Added
- Runnable examples for people who build agents with Pydantic AI or Google ADK. Each one checks a tool's output with zn-gate before the model reads it, in the way that framework expects: text that tries to give the model orders is blocked, secrets are hidden. They run locally with made-up pages and a stand-in model, and need no API key.
