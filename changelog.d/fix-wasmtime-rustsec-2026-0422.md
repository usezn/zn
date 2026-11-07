### Security
- The WebAssembly runtime (wasmtime) is updated from 48.0.7 to 48.0.8 to fix RUSTSEC-2026-0422, RUSTSEC-2026-0423 and RUSTSEC-2026-0424. zn-gate loads WebAssembly policy modules through core-module typed calls with integer arguments only, so none of the three could be reached through it; the update clears `cargo audit`.
