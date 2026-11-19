### Security
- The plugin repository build now also refuses code that reaches Node's module loader without the `module`
  built-in (`require.extensions`, the loader table, the Module class, internal bindings). Detection is partial: it does not yet follow aliases of `require` or `process`, or paths built by string concatenation. The one allowed use is
  the hook runner's per-call integrity check of the vault client files, pinned to its reviewed text.
