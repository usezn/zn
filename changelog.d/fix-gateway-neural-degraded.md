### Security
- Experimental Rust gateway (not distributed): `zn analyze` and the `zn mcp` tool `analyze_prompt` no longer report a plain allow when the neural or fusion check
  turned on in the configuration could not run (model failed to load, `ZN_FAST_BOOT`, or an inference error). The
  result now carries a `degraded` field with the reason and is a block with rule `check_unavailable`; `zn analyze`
  prints the result, writes a message to stderr and exits with code 2, and the tool returns an error result. Before, the check was skipped without a trace in the result.
