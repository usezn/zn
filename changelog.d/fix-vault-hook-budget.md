### Security
- A secret vault that stops answering no longer lets a tool's output reach the agent unredacted: hooks wait at most a few seconds for the vault in total, then redact the secrets for good instead of timing out.
