### Security
- Removing a file that only shares a policy's name, such as `name.sig` or `name.txt`, no longer unregisters that policy while the gateway runs. Only the `.wasm` file removes a policy, and renaming it away counts as removing it.
- When a signing key or allowed policy hashes are set, removing or breaking a `.wasm.sig` or `.wasm.pqs` signature file now unloads that policy while the gateway runs. The last loaded policy is never unloaded, and the policy delete endpoint refuses to delete it, so the gateway cannot end up with no policies.
- `zn analyze` and `zn mcp` now refuse to start, like `zn start`, when a signing key or allowed policy hashes are set and no policy loads.
