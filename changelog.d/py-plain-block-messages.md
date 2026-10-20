### Changed
- The Python package now uses the same plain-English block messages as Node.js: the text `zn-gate analyze` prints for a blocked input, the LangChain callback's replacement for a blocked tool output, the Promptfoo provider's blocked output, and the message for an oversized output blocked with `block_truncated`. Verdicts and rule ids do not change.
