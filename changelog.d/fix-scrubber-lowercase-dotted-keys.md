### Fixed
- The scrubber now redacts the value of a secret-named key written in lower case, mixed case or dotted form (for example `openai_api_key=...`, `my.app.db.password=...` or `github-token=...`), in prompts and in tool output, in both the Node.js and Python packages. Short, low-entropy, placeholder and reference values are still left alone.
