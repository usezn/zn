### Fixed
- The vault no longer expires its session before the first client connects when the machine is slow to start it, which could show up as a "vault is locked (EPIPE)" error right after `zn unlock`.
