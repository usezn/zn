### Security
- The MCP proxy no longer passes loader and interpreter start-up variables (`NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `BASH_ENV`, `LD_*`, `DYLD_*`, `GCONV_PATH` and the rest of the `zn run` list) from a server's `env` setting to the MCP server it starts. It skips them and logs a warning, the same way `zn run` does. `zn run` also drops `OPENSSL_CONF`.
