---
name: zn-secrets
description: Work with credentials when zn-gate protects this session. Use when a task needs an API key, token, password or other secret, when you see __ZN_<NAME>__ markers or __ZN_REDACTED_<TYPE>__ placeholders, or when a zn hook denies a tool call.
---

# Working with secrets under zn-gate

zn-gate runs on the user's machine. Secret values stay there: you only ever see
markers such as `__ZN_STRIPE_KEY__` (a named secret in the user's vault) or
tokens such as `__ZN_AWS_KEY_1__` (a value zn detected and replaced). Treat
markers and tokens as opaque names. Never ask the user to paste a secret value
into the conversation, and never try to recover a value.

## Use a secret without seeing it

- **HTTP APIs:** call the `secrets_http_request` tool of the `secrets` MCP
  server and put the marker where the value belongs (a header, the URL or the
  body). zn makes the request and returns the response with secrets masked.
- **Commands:** run them through `zn run -- <command>`. zn fills the markers
  only for commands the user allowed for that secret, and masks the output.
- **Files that need a real value** (for example a local config file): use
  `secrets_render_file`. The value is written to disk, never returned to you.
- **A secret that does not exist yet:** call `secrets_request` with the name
  you need. The user adds it with `zn secret set NAME` in their own terminal.

## When zn denies a call

A denial message starting with `zn:` explains why and what to do instead,
for example to use `zn run --` or the MCP server. Follow it. Do not try to
work around it by reading the file another way, encoding it, or asking the
user to switch zn off. If the message says the vault is locked, ask the user
to run `zn unlock` in their terminal.

## What zn does not cover

zn reduces what reaches the model; it is not a sandbox. Per-agent limits are
documented in https://github.com/usezn/zn/blob/v1.6.0/docs/compat.md.
