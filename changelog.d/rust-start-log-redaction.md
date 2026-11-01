### Fixed
- The experimental gateway (`zn start`) no longer writes log lines to stdout, which carries the JSON-RPC replies; logs and the first-run banner go to stderr. Log lines, tool names, audit rows and event metadata now pass through one redactor that also masks cloud, code-host, payment and chat tokens, private key blocks and IBANs. Forwarded calls are unchanged.
