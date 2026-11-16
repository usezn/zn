# Third-party notices

This repository does not distribute the third-party models or datasets listed below. They are listed for transparency.

## Rust crate (`src/`)

### rmcp and rmcp-macros (compiled into the gateway)

- Crates: `rmcp` and `rmcp-macros` 3.9.0, the Rust SDK of the Model Context Protocol
- Source: https://github.com/modelcontextprotocol/rust-sdk
- License: the crate manifests declare Apache License 2.0. Their LICENSE file adds that the MCP project is moving from the MIT License to Apache-2.0: new contributions are Apache-2.0, and contributions whose authors have not agreed to relicense remain under the MIT License. The compiled gateway therefore contains Apache-2.0 code and possibly some MIT code from these crates. Both licences are allowed by `deny.toml`.
- Copyright: Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.
- Use: the experimental Rust gateway in `src/` (not distributed) links these crates for its MCP client and server.

### all-MiniLM-L6-v2 (downloaded at runtime)

- Model: `sentence-transformers/all-MiniLM-L6-v2`
- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- License: Apache License 2.0, as declared on the model card (checked 2026-11-01)
- Use: `src/ai/embedder.rs` downloads the model from Hugging Face when the embedder first runs. The model weights are not included in the crate, the npm package or the PyPI package.
