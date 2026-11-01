# Third-party notices

This repository does not distribute the third-party models or datasets listed below. They are listed for transparency.

## Rust crate (`src/`)

### all-MiniLM-L6-v2 (downloaded at runtime)

- Model: `sentence-transformers/all-MiniLM-L6-v2`
- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- License: Apache License 2.0, as declared on the model card (checked 2026-11-01)
- Use: `src/ai/embedder.rs` downloads the model from Hugging Face when the embedder first runs. The model weights are not included in the crate, the npm package or the PyPI package.
