### Security
- The hook launchers no longer pass variables that load code into Node.js. The agent's environment, which a project can
  set, reached the hook unchanged, so `NODE_OPTIONS=--require` (or `--import`, or `LD_PRELOAD`) could run code inside the
  hook and turn a blocked call into an allowed one. The sh launcher and the OpenCode plugin now remove the loader and
  interpreter start-up variables that `zn run` already removed (`NODE_OPTIONS`, `NODE_PATH`, every `LD_*` and `DYLD_*`,
  `BASH_ENV` and the others) plus `OPENSSL_CONF` and `NODE_V8_COVERAGE` before they start Node.js; the Windows PowerShell
  launcher removes `NODE_OPTIONS`, `NODE_PATH` and `OPENSSL_CONF`. `NODE_EXTRA_CA_CERTS` and the proxy settings are kept.
  `zn-gate check` warns when one of these variables is set. `npm update -g zn-gate` rewrites the sh launchers; for
  OpenCode, and for the agents that use the PowerShell launcher on Windows, run `zn hooks install <agent>` again.
