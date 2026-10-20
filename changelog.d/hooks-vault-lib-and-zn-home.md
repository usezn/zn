### Security
- The agent can no longer load the vault client, daemon or store modules of zn-gate from a shell command (node, npx, bun, deno) to read or list secrets, and a custom ZN_HOME directory is now protected like ~/.zn.
