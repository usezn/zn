### Security
- `zn init` no longer replaces an existing `zn.json` that holds a key or token in clear text (`security.api_key`, `security.jwt_secret`, `security.mcp_ws_token` or `audit.encryption_key`). It leaves the file as it is, names each setting (never the value) and the environment variable to use instead, and asks you to remove those settings and run it again.
