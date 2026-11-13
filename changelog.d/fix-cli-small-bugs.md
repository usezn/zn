### Fixed

- `zn-gate init --wrap-mcp` now exits with code 1 when a config could not be wrapped (an error, a config zn cannot read, or one left to wrap by hand); before it always exited 0.
- `zn vault log` refuses an unknown option or argument instead of taking the next word as its value.
- `zn env shadow --help` names the real default mode (env).
- The top-level help lists the `wrap` alias of `shield` and the options of `secret set`, `secret import` and `env shadow`.
