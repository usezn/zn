### Changed
- A key in `~/.zn/config.json` that zn does not read (at the top level or under `hooks`) and a text setting outside its allowed values are now reported by the hook's once-per-session message, `zn-gate check` and `zn-gate status`, with the closest valid key ("Did you mean ...") or the valid values. The setting keeps its stricter default as before.
