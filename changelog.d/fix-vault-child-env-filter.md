### Security
- The vault daemon, the keychain and dialog helpers, the browser opener and the clipboard and process tools no longer receive the caller's loader and interpreter start-up variables (NODE_OPTIONS, LD_PRELOAD and the like), so code of the caller's choosing cannot load into the process that holds the vault identity. `zn run` uses the same list.
