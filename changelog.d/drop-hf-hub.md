### Changed
- The gateway downloads its embedding model directly from a pinned revision and checks its hash, including on a model already on disk (a corrupted copy is replaced); no third-party download library.
