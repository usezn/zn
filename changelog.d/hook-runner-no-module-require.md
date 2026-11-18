### Security

- The hook runner no longer names Node's "module" built-in. The per-call check of the vault client files reads the same loader through `require.extensions`, so the check is unchanged (an edited, missing or linked vault file still stops the call) and the Claude plugin repository's build accepts the package again.
