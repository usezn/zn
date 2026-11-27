### Security
- Removing a file that only shares a policy's name, such as `name.sig` or `name.txt`, no longer unregisters that policy while the gateway runs. Only the `.wasm` file removes a policy. Adding, changing or removing a `.wasm.sig` or `.wasm.pqs` signature file now checks the policy again, and a policy that no longer verifies stays as it was loaded and is logged instead of being dropped.
- `zn analyze` and the other commands that load policies now refuse to run, like `zn start`, when a signing key or allowed policy hashes are set and the policies do not load.
