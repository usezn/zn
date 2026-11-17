### Fixed

- Checking a very long chain of command wrappers (`nice`, `timeout`, `stdbuf` and the like) in front of a command for network requests is faster: the program names in the chain are looked up once per distinct word instead of once for each repeat.
