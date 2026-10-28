### Fixed
- Python: with `on_block="ignore"` (or `raise_on_injection=False` / `raise_on_violation=False`), the LangChain callback handler and the LlamaIndex query guard now log a warning (logger `zn_gate`) when they let a blocked prompt, tool call or output through, with the rule and where it happened, never the text. Before, nothing showed that zn had found anything.
