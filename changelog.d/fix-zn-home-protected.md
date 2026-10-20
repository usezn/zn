### Security
- Agents can no longer read or write the folder `ZN_HOME` points to. zn already protected `~/.zn`; when you moved zn's state elsewhere with `ZN_HOME`, that folder (vault, audit log, stats) was not covered by the hooks.
