### Security
- LangChain integration: secrets are now also masked when they sit in dictionary keys, sets, frozensets or objects such as pydantic models in a tool result, in both the wrapped tool and the callback handler. A result with a secret that cannot be masked is blocked.
