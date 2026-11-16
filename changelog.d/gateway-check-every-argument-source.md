### Fixed
- The experimental Rust gateway (not distributed) checks every tool-call argument key (`arguments`, `args` and `input`) when a request carries more than one, instead of only the first one found.
