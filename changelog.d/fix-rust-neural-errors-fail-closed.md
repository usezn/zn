### Security
- When the neural layer fails on a call (embedding, classifier or memory search), `zn serve`, `zn analyze` and `zn mcp` now log the error, count it in `zn_neural_errors_total` and deny the call if neural blocking is on, instead of skipping the neural check and allowing it. With blocking off the call still goes through, with the error logged and counted.
- `zn analyze` and `zn mcp` no longer fall back to a stub that never fires when the neural model fails to load: they stop with a clear error, like `zn serve`. Set `ZN_FAST_BOOT=1` to run without the neural layer on purpose.
