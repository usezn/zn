### Security
- The plugin repository build now also refuses code that reaches Node's module loader without the `module`
  built-in (`require.extensions`, the loader table, the Module class, internal bindings). The one allowed use is
  the hook runner's per-call integrity check of the vault client files, pinned to its reviewed text.
