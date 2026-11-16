### Security
- The hook now checks the vault files on every call, even when the call does not need the vault. A vault file that was edited, deleted or replaced by a link after install blocks the call, as any other changed file does.
