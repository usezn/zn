### Security
- `zn audit` no longer shows the value that follows a credential flag such as `--password` as the package name of an npx MCP server, and the finding now names the real package. The same applies to `uvx` and `docker run`, and a flag like `--client-secret` is now hidden too.
