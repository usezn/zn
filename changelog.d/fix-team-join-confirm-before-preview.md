### Security
- `zn team join` no longer sends the join token to `api.usezn.com` before you agree. The vault now asks first whether it may look up which organization the token is for, and only then shows the organization and asks to confirm the join. With no confirmation channel (no terminal for the vault, or an agent run) nothing is sent.
