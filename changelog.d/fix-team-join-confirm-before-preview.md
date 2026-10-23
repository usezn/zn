### Security
- `zn team join` no longer sends the join token to `api.usezn.com` before you agree. The vault now asks first whether it may look up which organization the token is for, and only then shows the organization and asks to confirm the join. With no confirmation channel (no terminal for the vault, or an agent run) nothing is sent.
- `zn team join` waits up to 5 minutes for your two answers (the organization check and the join), so a slow answer does not time out.
