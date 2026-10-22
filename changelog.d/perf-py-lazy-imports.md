### Changed
- The Python package starts faster: importing `zn_gate` no longer compiles every rule up front or loads the cloud client and the framework adapters until they are used, which cuts the cold start of a local check by more than half.
