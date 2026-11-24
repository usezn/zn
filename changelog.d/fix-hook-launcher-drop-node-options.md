### Security
- The plugin hook scripts now remove the variables that load code into Node.js before they start it. The Claude Code and
  Codex plugin script (`scripts/zn-node.sh`) and the ZCode plugin scripts (`zn-hook.sh`, and `zn-hook.ps1` on Windows)
  passed the agent's environment, which a project can set, to Node.js unchanged, so a `NODE_OPTIONS=--require` preload ran
  before the plugin launcher could check anything. They now drop the same list as the `zn hooks install` launchers
  (`NODE_OPTIONS`, `NODE_PATH`, every `LD_*` and `DYLD_*` and the others; on Windows `NODE_OPTIONS`, `NODE_PATH` and
  `OPENSSL_CONF`). `NODE_EXTRA_CA_CERTS` and the proxy settings are kept. Update the plugin to get the new scripts.
